import "server-only";

import type { BoundClient } from "./client";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  deterministicRuntimeObjectId,
  publishRuntimeObject,
} from "./runtime-objects";

import { MaisterError } from "@/lib/errors";

export type PublishedCapabilityBundle = {
  profileObjectId: string;
  instructionsObjectId: string;
};

async function readCapabilityFile(
  path: string,
  logicalName: string,
): Promise<Uint8Array> {
  try {
    return Uint8Array.from(await readFile(path));
  } catch (cause) {
    throw new MaisterError(
      "PRECONDITION",
      `capability input ${logicalName} is unreadable`,
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
}

async function publishCapabilityFile(input: {
  client: BoundClient;
  runId: string;
  sourceId: string;
  logicalName: string;
  path: string;
  kind: "capability_profile" | "capability_instructions";
  mimeType: "application/json" | "text/markdown";
}): Promise<string> {
  const bytes = await readCapabilityFile(input.path, input.logicalName);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectId = deterministicRuntimeObjectId({
    runId: input.runId,
    // Runtime objects are immutably fenced to the assignment that reserved
    // them. A resumed node reuses its attempt id but owns a new assignment, so
    // the retry-stable object id must include that generation boundary.
    sourceKey: `${input.kind}:${input.sourceId}:assignment:${input.client.assignment.id}`,
    sha256,
  });
  const published = await publishRuntimeObject({
    client: input.client,
    objectId,
    kind: input.kind,
    logicalName: input.logicalName,
    mimeType: input.mimeType,
    retentionClass: "run",
    bytes,
  });

  return published.objectId;
}

export async function publishCapabilityBundle(input: {
  client: BoundClient;
  runId: string;
  sourceId: string;
  profileLogicalName: string;
  profilePath: string;
  instructionsLogicalName: string;
  instructionsPath: string;
}): Promise<PublishedCapabilityBundle> {
  const [profileObjectId, instructionsObjectId] = await Promise.all([
    publishCapabilityFile({
      ...input,
      logicalName: input.profileLogicalName,
      path: input.profilePath,
      kind: "capability_profile",
      mimeType: "application/json",
    }),
    publishCapabilityFile({
      ...input,
      logicalName: input.instructionsLogicalName,
      path: input.instructionsPath,
      kind: "capability_instructions",
      mimeType: "text/markdown",
    }),
  ]);

  return { profileObjectId, instructionsObjectId };
}
