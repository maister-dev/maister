import "server-only";

import type { Db } from "./db";
import type { RuntimeObjectHoldReason } from "./types";
import type { ExecutionRuntimeObject } from "@/lib/db/schema";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import {
  artifactInstances,
  executionCommands,
  executionRuntimeObjects,
  runResults,
  runSessionIncarnations,
  runs,
  scratchAttachments,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const REFERENCEABLE_STATES = new Set<ExecutionRuntimeObject["state"]>([
  "pending",
  "available",
]);
const OPEN_COMMAND_STATES = ["queued", "delivering", "accepted"] as const;

export class RuntimeObjectHeldError extends MaisterError {
  constructor(readonly hold: RuntimeObjectHoldReason) {
    super("PRECONDITION", "runtime object is retained", {
      details: { reason: "runtime_object_retained", hold },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Lock every object a new reference names so a reference and a deletion
 * claim cannot interleave (D5); a tombstoned or lost object refuses. */
export async function assertRuntimeObjectsReferenceable(
  tx: Db,
  objectIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(objectIds)];

  if (ids.length === 0) return;
  const rows = await tx
    .select({
      id: executionRuntimeObjects.id,
      state: executionRuntimeObjects.state,
    })
    .from(executionRuntimeObjects)
    .where(inArray(executionRuntimeObjects.id, ids))
    .for("update");
  const referenceable = new Set(
    rows.filter((row) => REFERENCEABLE_STATES.has(row.state)).map((r) => r.id),
  );
  const refused = ids.filter((id) => !referenceable.has(id));

  if (refused.length > 0)
    throw new MaisterError(
      "PRECONDITION",
      "runtime object is no longer available for a new reference",
      { details: { reason: "runtime_object_missing", objectIds: refused } },
    );
}

async function referenceHold(
  tx: Db,
  object: ExecutionRuntimeObject,
): Promise<RuntimeObjectHoldReason | null> {
  const artifacts = await tx
    .select({
      required: sql<boolean>`jsonb_array_length(coalesce(${artifactInstances.requiredFor}, '[]'::jsonb)) > 0`,
    })
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.runId, object.runId),
        sql`${artifactInstances.locator}->>'kind' = 'execution-object'`,
        sql`${artifactInstances.locator}->>'objectId' = ${object.id}`,
      ),
    );

  if (artifacts.some((artifact) => artifact.required))
    return "required_evidence";
  if (artifacts.length > 0) return "referenced_artifact";
  const [attachment] = await tx
    .select({ id: scratchAttachments.id })
    .from(scratchAttachments)
    .where(
      and(
        eq(scratchAttachments.runId, object.runId),
        eq(scratchAttachments.kind, "uploaded_file"),
        eq(scratchAttachments.value, object.id),
      ),
    )
    .limit(1);

  return attachment ? "referenced_attachment" : null;
}

export async function hasOpenRuntimeObjectCommand(
  tx: Db,
  objectId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.targetSessionId, objectId),
        sql`${executionCommands.kind} LIKE 'runtime_object.%'`,
        inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
      ),
    )
    .limit(1);

  return Boolean(row);
}

async function deliveryConfirmed(tx: Db, runId: string): Promise<boolean> {
  const [run] = await tx
    .select({ mergeCommitSha: runs.mergeCommitSha })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (run?.mergeCommitSha) return true;
  const [merged] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.runId, runId),
        eq(workspaces.prState, "merged"),
        isNotNull(workspaces.prMergedAt),
      ),
    )
    .limit(1);

  if (merged) return true;
  const [collected] = await tx
    .select({ id: runResults.id })
    .from(runResults)
    .where(
      and(eq(runResults.runId, runId), isNotNull(runResults.firstCollectedAt)),
    )
    .limit(1);

  return Boolean(collected);
}

/** D5 retention holds, evaluated under the object row lock inside the
 * deletion claim: references and required evidence, live sessions, open
 * commands and unconfirmed delivery keep bytes regardless of their age. */
export async function evaluateRuntimeObjectHold(
  tx: Db,
  object: ExecutionRuntimeObject,
): Promise<RuntimeObjectHoldReason | null> {
  const reference = await referenceHold(tx, object);

  if (reference) return reference;
  const [live] = await tx
    .select({ id: runSessionIncarnations.id })
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, object.runId),
        inArray(runSessionIncarnations.state, [
          "created",
          "active",
          "checkpointed",
        ]),
      ),
    )
    .limit(1);

  if (live) return "live_session";
  if (await hasOpenRuntimeObjectCommand(tx, object.id))
    return object.state === "deleting" ? "delete_pending" : "open_command";
  if (
    object.retentionClass === "delivery" &&
    !(await deliveryConfirmed(tx, object.runId))
  )
    return "delivery_unconfirmed";

  return null;
}
