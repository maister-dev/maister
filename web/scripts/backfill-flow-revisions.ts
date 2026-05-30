import "@/lib/load-env";

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { manifestDigest } from "@/lib/flows/digest";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows, flowRevisions, runs } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "backfill-flow-revisions",
  level: process.env.LOG_LEVEL ?? "info",
});

// One-time M10 backfill (ADR-021). Seeds an immutable flow_revisions row from
// every existing flows row, points the project enablement pointer at it, and
// links historical runs by (flow_ref_id, flow_revision). Idempotent: safe to
// re-run. SQL cannot compute the sha256 manifest digest over canonical JSON, so
// this runs as a TS step AFTER the DDL migration 0007.

type ContractFields = {
  capabilities?: string[];
  gates?: string[];
  artifacts?: string[];
  external_ops?: string[];
};

function contractOf(manifest: FlowYamlV1): ContractFields {
  return {
    capabilities: manifest.capabilities,
    gates: manifest.gates,
    artifacts: manifest.artifacts,
    external_ops: manifest.external_ops,
  };
}

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

async function main(): Promise<void> {
  // FIXME(any): dual drizzle-orm peer-dep variants; see seed.ts.
  const db = getDb() as unknown as {
    select: any;
    insert: any;
    update: any;
  };

  const flowRows: Array<Record<string, any>> = await db.select().from(flows);

  log.info({ count: flowRows.length }, "backfill start");

  let revisionsCreated = 0;
  let revisionsReused = 0;
  let flowsLinked = 0;
  let runsLinked = 0;

  for (const flow of flowRows) {
    const manifest = flow.manifest as FlowYamlV1;
    const digest = manifestDigest(manifest);
    // Content-address legacy rows. A real 40-hex git SHA is kept as-is (same
    // SHA = same bytes = legitimately shared across projects). Anything else —
    // null, the "unknown" sentinel from old local-source installs, or any
    // non-SHA value — is derived from the manifest digest so two projects that
    // share a flow id but carry DIFFERENT manifests resolve to DISTINCT
    // revisions instead of colliding on (flowRefId, "unknown") and reusing the
    // wrong manifest/cache path (Codex finding #2).
    const isSha =
      typeof flow.revision === "string" && /^[0-9a-f]{40}$/.test(flow.revision);
    const resolvedRevision: string = isSha
      ? flow.revision
      : digest.slice(0, 40);

    // Upsert the immutable revision (global, content-addressed).
    const inserted: Array<{ id: string }> = await db
      .insert(flowRevisions)
      .values({
        id: randomUUID(),
        flowRefId: flow.flowRefId,
        source: flow.source,
        versionLabel: flow.version,
        resolvedRevision,
        manifestDigest: digest,
        manifest,
        schemaVersion: flow.schemaVersion,
        engineMin: manifest.compat?.engine_min ?? null,
        engineMax: manifest.compat?.engine_max ?? null,
        contract: contractOf(manifest),
        installedPath: flow.installedPath,
        setupStatus: "done",
        packageStatus: "Installed",
      })
      .onConflictDoNothing({
        target: [flowRevisions.flowRefId, flowRevisions.resolvedRevision],
      })
      .returning({ id: flowRevisions.id });

    let revisionId = inserted[0]?.id;

    if (revisionId) {
      revisionsCreated += 1;
    } else {
      const existing: Array<{ id: string }> = await db
        .select({ id: flowRevisions.id })
        .from(flowRevisions)
        .where(
          and(
            eq(flowRevisions.flowRefId, flow.flowRefId),
            eq(flowRevisions.resolvedRevision, resolvedRevision),
          ),
        );

      revisionId = existing[0]?.id;
      revisionsReused += 1;
    }

    if (!revisionId) {
      throw new Error(
        `failed to resolve flow_revisions id for ${flow.flowRefId}@${resolvedRevision}`,
      );
    }

    // Point the project enablement pointer at the revision. Grandfather
    // existing installs as Enabled + trusted_by_policy.
    await db
      .update(flows)
      .set({
        enabledRevisionId: revisionId,
        enablementState: "Enabled",
        trustStatus: "trusted_by_policy",
        updatedAt: new Date(),
      })
      .where(eq(flows.id, flow.id));
    flowsLinked += 1;

    // Link historical runs launched against this flow's current revision.
    // Runs pinned to a different (older) SHA have no revision row and stay
    // null — the runner falls back to flows.manifest (legacy path).
    const updatedRuns: Array<{ id: string }> = await db
      .update(runs)
      .set({ flowRevisionId: revisionId })
      .where(
        and(
          eq(runs.flowId, flow.id),
          eq(runs.flowRevision, resolvedRevision),
          isNull(runs.flowRevisionId),
        ),
      )
      .returning({ id: runs.id });

    runsLinked += updatedRuns.length;
  }

  log.info(
    { revisionsCreated, revisionsReused, flowsLinked, runsLinked },
    "backfill complete",
  );
}

main()
  .then(async () => {
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    if (isMaisterError(err)) {
      log.error({ code: err.code, message: err.message }, "backfill failed");
    } else {
      log.error({ err }, "backfill failed (unexpected)");
    }
    await flushLogger();
    process.exit(1);
  });
