import "server-only";

import type { Db } from "./db";
import type { workspaces } from "@/lib/db/schema";
import type { WorkspaceDiffQuery } from "../../../runtime/workspace-prepare";

import { runEventWakeBus } from "./events/run-wake";
import {
  getRuntimeObjectForRun,
  readRuntimeObjectContent,
} from "./runtime-objects";
import { readAddressedWorkspaceDiff } from "./workspace-preparation";

import { MaisterError } from "@/lib/errors";

/** Read the exact sealed object after its source event has passed catalogue projection. */
export async function readAddressedWorkspacePatch(
  input: Readonly<{
    db: Db;
    workspace: typeof workspaces.$inferSelect;
    range: Omit<WorkspaceDiffQuery, "generation">;
    signal: AbortSignal;
  }>,
): Promise<string> {
  const { db, workspace } = input;
  const runId = workspace.runId;
  input.signal.throwIfAborted();
  const { object: reference } = await readAddressedWorkspaceDiff(
    db,
    workspace,
    input.range,
  );
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  while (!signal.aborted) {
    const record = await getRuntimeObjectForRun({
      db,
      runId,
      objectId: reference.objectId,
    });
    if (record && record.object.state !== "pending") {
      const object = record.object;
      if (
        object.executionHostId !== workspace.executionHostId ||
        object.sha256 !== reference.sha256 ||
        object.mimeType !== "text/x-diff" ||
        object.logicalName !== "workspace-diff.patch" ||
        object.kind !== "diagnostic" ||
        object.sizeBytes === null ||
        object.sizeBytes > 64 * 1024
      )
        throw new MaisterError(
          "ACP_PROTOCOL",
          "The sealed diff does not match the addressed workspace reference",
        );
      const { content } = await readRuntimeObjectContent({
        db,
        runId,
        objectId: reference.objectId,
        signal,
      });

      return new TextDecoder().decode(content.bytes);
    }
    await runEventWakeBus.wait(runId, 2_000, signal);
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "The selected host's diff has not been applied",
    {
      details: { reason: "workspace_diff_pending" },
    },
  );
}
