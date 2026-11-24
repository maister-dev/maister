import "server-only";

import type {
  WorkspaceInputObject,
  WorkspaceMaterializeRequest,
} from "../../../runtime/workspace-prepare";
import type { Db } from "./db";
import type { BoundClient } from "./client";

import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { canonicalCommandJson } from "../../../runtime/command-json";
import {
  WORKSPACE_INPUT_MAX_BYTES,
  WORKSPACE_INPUT_MAX_FILES,
} from "../../../runtime/workspace-input-policy";
import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";

import { COMMAND_POLICY } from "./deliverer";
import { issueCommand } from "./ledger";
import {
  deterministicRuntimeObjectId,
  publishRuntimeObject,
} from "./runtime-objects";

import {
  executionAssignments,
  executionCommands,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type WorkspaceInputFile = Readonly<{
  path: string;
  bytes: Uint8Array;
  executable?: true;
}>;

function changed(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Workspace input owner or frozen materialization changed",
    {
      details: { reason: "workspace_preparation_changed" },
    },
  );
}

async function publishInput(
  client: BoundClient,
  bytes: Uint8Array,
  sourceKey: string,
  logicalName: string,
  kind: "capability_profile" | "capability_instructions",
): Promise<WorkspaceInputObject> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectId = deterministicRuntimeObjectId({
    runId: client.assignment.runId,
    sourceKey: `workspace-input:${client.assignment.epoch}:${sourceKey}`,
    sha256,
  });
  const published = await publishRuntimeObject({
    client,
    objectId,
    kind,
    logicalName,
    bytes,
    retentionClass: "run",
    mimeType:
      kind === "capability_profile"
        ? "application/json"
        : "application/octet-stream",
  });
  if (
    published.metadata.state !== "available" ||
    published.metadata.sha256 !== sha256
  )
    throw new MaisterError(
      "ACP_PROTOCOL",
      "Selected host did not seal its workspace input",
    );

  return { objectId, sha256 };
}

/** Bind verified manager-owned bytes to an already prepared workspace.
 * Current authority is checked again in the command reservation transaction. */
export async function queueWorkspaceInputs(
  db: Db,
  input: Readonly<{
    client: BoundClient;
    files: readonly WorkspaceInputFile[];
    assertAuthority: (db: Db) => Promise<void>;
  }>,
): Promise<string> {
  const { client, files, assertAuthority } = input;
  const { assignment, host } = client;
  const handle = assignment.executionWorkspaceId;
  if (!handle) throw changed();
  if (
    files.length > WORKSPACE_INPUT_MAX_FILES ||
    files.reduce((sum, file) => sum + file.bytes.byteLength, 0) >
      WORKSPACE_INPUT_MAX_BYTES
  )
    throw new MaisterError(
      "PRECONDITION",
      "Frozen workspace inputs exceed their generation budget",
    );
  await assertAuthority(db);
  const [owned] = await db
    .select({
      inputDigest: workspaces.workspaceInputDigest,
      generation: workspaces.workspaceGeneration,
    })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.runId, assignment.runId),
        eq(workspaces.executionHostId, host.id),
        eq(workspaces.preparationAssignmentId, assignment.id),
        eq(workspaces.ownershipKind, "host_owned"),
        isNull(workspaces.removedAt),
      ),
    );
  if (!owned?.inputDigest || !owned.generation) throw changed();

  const published: Array<
    WorkspaceInputObject & Pick<WorkspaceInputFile, "path" | "executable">
  > = [];
  for (const [index, file] of [...files]
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    .entries()) {
    const reference = await publishInput(
      client,
      file.bytes,
      file.path,
      `workspace-input-${index}.bin`,
      "capability_instructions",
    );
    published.push({
      ...reference,
      path: file.path,
      ...(file.executable ? { executable: true } : {}),
    });
  }
  const manifest = await publishInput(
    client,
    Buffer.from(
      canonicalCommandJson({
        version: 1,
        workspaceInputDigest: owned.inputDigest,
        files: published,
      }),
    ),
    "manifest",
    "workspace-inputs.json",
    "capability_profile",
  );
  const payload: WorkspaceMaterializeRequest["payload"] = {
    generation: owned.generation,
    manifestDigest: manifest.sha256,
    objects: [
      manifest,
      ...published.map(({ objectId, sha256 }) => ({ objectId, sha256 })),
    ],
  };

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status, assignmentId: runs.executionAssignmentId })
      .from(runs)
      .where(eq(runs.id, assignment.runId))
      .for("update");
    const [active] = await tx
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, assignment.id))
      .for("update");
    if (
      run?.status !== "Pending" ||
      run.assignmentId !== assignment.id ||
      active?.state !== "active" ||
      active.executionWorkspaceId !== handle
    )
      throw changed();
    // Ingest serializes on the Run before updating the host's last-seen fields.
    await assertAuthority(tx);
    const [existing] = await tx
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.executionAssignmentId, assignment.id),
          eq(executionCommands.kind, "workspace.materialize"),
        ),
      );
    if (existing) {
      if (
        workspaceEvidenceDigest(existing.payload) !==
          workspaceEvidenceDigest(payload) ||
        existing.targetSessionId !== handle
      )
        throw changed();
      return existing.id;
    }
    const command = await issueCommand(tx, {
      kind: "workspace.materialize",
      assignment: active,
      host,
      payload,
      targetSessionId: handle,
      maxAttempts: COMMAND_POLICY["workspace.materialize"].maxAttempts,
    });

    return command.row.id;
  });
}
