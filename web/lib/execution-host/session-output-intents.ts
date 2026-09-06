import type { Db } from "./db";
import type { BoundClient } from "./client";
import type { CreateSessionPayload } from "./contracts";

import { eq } from "drizzle-orm";

import { executionRuntimeObjects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export async function ensureSessionOutputIntents(
  db: Db,
  client: BoundClient,
  payload: Pick<CreateSessionPayload, "outputObjects">,
): Promise<void> {
  if ((payload.outputObjects?.length ?? 0) > 0)
    await db.transaction(async (tx) => {
      for (const output of payload.outputObjects ?? []) {
        const expiresAt = output.expiresAt ? new Date(output.expiresAt) : null;
        const rows = await tx
          .select()
          .from(executionRuntimeObjects)
          .where(eq(executionRuntimeObjects.id, output.objectId))
          .for("update")
          .limit(1);
        const existing = rows[0];

        if (existing) {
          const sameBinding =
            existing.runId === client.assignment.runId &&
            existing.executionHostId === client.host.id &&
            existing.executionAssignmentId === client.assignment.id &&
            existing.assignmentEpoch === client.assignment.epoch &&
            existing.kind === output.kind &&
            existing.logicalName === output.logicalName &&
            existing.mimeType === output.mimeType &&
            existing.generation === output.generation &&
            existing.retentionClass === output.retentionClass &&
            existing.expiresAt?.getTime() === expiresAt?.getTime() &&
            (existing.state === "pending" || existing.state === "available");

          if (!sameBinding) {
            throw new MaisterError(
              "CONFLICT",
              "runtime output object ID is already bound to different metadata",
              { details: { reason: "command_invariant_conflict" } },
            );
          }
          continue;
        }
        await tx.insert(executionRuntimeObjects).values({
          id: output.objectId,
          runId: client.assignment.runId,
          executionHostId: client.host.id,
          executionAssignmentId: client.assignment.id,
          assignmentEpoch: client.assignment.epoch,
          kind: output.kind,
          logicalName: output.logicalName,
          mimeType: output.mimeType,
          sizeBytes: null,
          sha256: null,
          generation: output.generation,
          retentionClass: output.retentionClass,
          state: "pending",
          expiresAt,
        });
      }
    });
}
