import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import {
  enqueueTrustedSetup,
  finishTrustedSetup,
  lockCurrentFlowSetup,
} from "@/lib/project-dependencies/post-trust-store";
import { withSetupAuthority } from "@/lib/project-dependencies/setup";
import { requireParentPackageTrust } from "@/lib/project-dependencies/member-trust";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { runRevisionSetup } from "@/lib/flows";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows, flowRevisions } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "exec-trust",
  level: process.env.LOG_LEVEL ?? "info",
});

// Flip the enabled revision's exec_trust to 'trusted' and run a pending
// setup.sh (if any). Idempotent: if exec_trust is already 'trusted' and
// setupStatus is 'done', returns immediately.
//
// Preconditions:
//   - project must exist and have an enabled revision (enabledRevisionId ≠ null)
//   - the flow must be scoped to the given projectId
//
// flowId is the `flows.id` row UUID (as used in URL params), NOT flowRefId.
export async function trustExecutable(args: {
  projectId: string;
  flowId: string;
  actorUserId?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
}): Promise<{ execTrust: "trusted"; setupStatus: string }> {
  const db = args.db ?? getDb();

  log.debug(
    { projectId: args.projectId, flowId: args.flowId },
    "trustExecutable start",
  );

  // Load the flow row for this project (flowId is the flows.id UUID).
  const flowRows = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, args.flowId), eq(flows.projectId, args.projectId)));
  const flow = flowRows[0];

  if (!flow) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${args.flowId}" not found for project ${args.projectId}`,
    );
  }

  if (!flow.enabledRevisionId) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${args.flowId}" has no enabled revision`,
    );
  }

  await requireParentPackageTrust(db, flow.packageInstallId);

  // Load the enabled revision.
  const revRows = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flow.enabledRevisionId));
  const rev = revRows[0];

  if (!rev) {
    throw new MaisterError(
      "PRECONDITION",
      `enabled revision ${flow.enabledRevisionId} not found`,
    );
  }

  // Flip exec_trust → trusted unconditionally (idempotent).
  const queued = await db.transaction(async (tx: Db) => {
    await lockCurrentFlowSetup(tx, flow, args.actorUserId);
    await tx
      .update(flowRevisions)
      .set({ execTrust: "trusted" })
      .where(eq(flowRevisions.id, rev.id));

    return enqueueTrustedSetup(
      tx,
      args.actorUserId,
      { kind: "flow", id: rev.id },
      args.projectId,
    );
  });

  await finishTrustedSetup(db, queued);

  log.debug(
    { projectId: args.projectId, flowId: args.flowId, revisionId: rev.id },
    "exec_trust set to trusted",
  );

  // Run pending setup.sh if needed.
  let setupStatus: string = rev.setupStatus;

  if (queued.length) {
    const [completed] = await db
      .select({ status: flowRevisions.setupStatus })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, rev.id));
    setupStatus = completed.status;
  } else if (rev.setupStatus === "pending" || rev.setupStatus === "failed") {
    setupStatus = await withSetupAuthority(
      db,
      (tx) => lockCurrentFlowSetup(tx, flow, args.actorUserId),
      () =>
        runRevisionSetup({
          db,
          revisionId: rev.id,
          installedPath: rev.installedPath,
        }),
    );

    if (setupStatus === "failed") {
      throw new MaisterError(
        "FLOW_INSTALL",
        `setup.sh failed for revision ${rev.id} of flow "${args.flowId}"`,
      );
    }
  }

  log.info(
    {
      projectId: args.projectId,
      flowId: args.flowId,
      revisionId: rev.id,
      setupStatus,
    },
    "trustExecutable complete",
  );

  return { execTrust: "trusted", setupStatus };
}
