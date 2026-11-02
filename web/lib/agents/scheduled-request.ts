import { z } from "zod";

import { MaisterError } from "@/lib/errors-core";

export const SCHEDULED_REQUEST_MAX_CODE_POINTS = 8000;

export function normalizeScheduledRequest(value: string | null): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0")
  ) {
    throw new MaisterError(
      "CONFIG",
      "Scheduled request contains unsupported characters",
    );
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();

  if ([...normalized].length > SCHEDULED_REQUEST_MAX_CODE_POINTS) {
    throw new MaisterError(
      "CONFIG",
      "Scheduled request exceeds 8000 Unicode code points",
    );
  }

  return normalized || null;
}

const canonicalRequestSchema = z.string().refine((value) => {
  try {
    return normalizeScheduledRequest(value) === value;
  } catch (error) {
    if (error instanceof MaisterError) return false;
    throw error;
  }
});

export const scheduledRequestSnapshotSchema = z
  .object({
    version: z.literal(1),
    scheduleId: z.string().min(1).max(256),
    triggerAttemptId: z.string().min(1).max(256),
    requestAtLaunch: canonicalRequestSchema.nullable(),
  })
  .strict();

export type ScheduledAgentRequestSnapshot = z.infer<
  typeof scheduledRequestSnapshotSchema
>;
export type ScheduledRequestState =
  "present" | "empty" | "legacy_unrecorded" | "not_applicable";

export function parseScheduledRequestSnapshot(
  value: unknown,
): ScheduledAgentRequestSnapshot | null {
  if (value === null || value === undefined) return null;
  const result = scheduledRequestSnapshotSchema.safeParse(value);

  if (!result.success) {
    throw new MaisterError("CONFIG", "Scheduled request snapshot is invalid", {
      details: { reason: "scheduled_request_snapshot_invalid" },
    });
  }

  return result.data;
}

export function scheduledRequestBlock(
  snapshot: ScheduledAgentRequestSnapshot | null,
): string | null {
  if (snapshot?.requestAtLaunch == null) return null;

  return [
    "## Current request (scheduled invocation)",
    "This is the current request for this invocation. Standing instructions, permission and isolation policy, human approvals and completion contracts remain authoritative.",
    snapshot.requestAtLaunch,
  ].join("\n\n");
}

/** Append only after ordinary template/capability rendering; request text is literal. */
export function appendScheduledRequest(
  prompt: string,
  snapshot: ScheduledAgentRequestSnapshot | null,
): string {
  const block = scheduledRequestBlock(snapshot);

  return block ? `${prompt}\n\n${block}` : prompt;
}
