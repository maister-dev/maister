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

export type CapabilityBundleContent = Readonly<{
  profile: string;
  instructions: string;
}>;

type PublishCapabilityBundleInput = Readonly<{
  client: BoundClient;
  runId: string;
  sourceId: string;
  profileLogicalName: string;
  instructionsLogicalName: string;
}>;

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
  bytes: Uint8Array;
  kind: "capability_profile" | "capability_instructions";
  mimeType: "application/json" | "text/markdown";
}): Promise<string> {
  const { bytes } = input;
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

export async function publishCapabilityBundle(
  input: PublishCapabilityBundleInput & {
    profilePath: string;
    instructionsPath: string;
  },
): Promise<PublishedCapabilityBundle> {
  const [profile, instructions] = await Promise.all([
    readCapabilityFile(input.profilePath, input.profileLogicalName),
    readCapabilityFile(input.instructionsPath, input.instructionsLogicalName),
  ]);

  return publishCapabilityObjects(input, { profile, instructions });
}

export function publishCapabilityBundleContent(
  input: PublishCapabilityBundleInput,
  content: CapabilityBundleContent,
): Promise<PublishedCapabilityBundle> {
  return publishCapabilityObjects(input, {
    profile: Buffer.from(content.profile),
    instructions: Buffer.from(content.instructions),
  });
}

async function publishCapabilityObjects(
  input: PublishCapabilityBundleInput,
  content: { profile: Uint8Array; instructions: Uint8Array },
): Promise<PublishedCapabilityBundle> {
  const [profileObjectId, instructionsObjectId] = await Promise.all([
    publishCapabilityFile({
      ...input,
      logicalName: input.profileLogicalName,
      bytes: content.profile,
      kind: "capability_profile",
      mimeType: "application/json",
    }),
    publishCapabilityFile({
      ...input,
      logicalName: input.instructionsLogicalName,
      bytes: content.instructions,
      kind: "capability_instructions",
      mimeType: "text/markdown",
    }),
  ]);

  return { profileObjectId, instructionsObjectId };
}
