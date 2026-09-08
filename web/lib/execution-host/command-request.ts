import "server-only";

import type { CommandEnvelope } from "./types";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { SendPromptInput } from "@/lib/supervisor-client";

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalCommandJson,
  CommandJsonError,
} from "../../../runtime/command-json";

import { MaisterError } from "@/lib/errors";

export const COMMAND_REQUEST_SCHEMA = "maister.command.request.v2" as const;
const id = z.string().min(1).max(128);
const safeSegment = id.regex(/^[a-zA-Z0-9_-]+$/);
const contentMetadata = {
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
  description: z.string().max(4_000).optional(),
};
const PromptPayloadSchema = z
  .object({
    stepId: safeSegment,
    nodeAttemptId: safeSegment.optional(),
    prompt: z.string().max(1_000_000),
    contentBlocks: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }).strict(),
          z
            .object({
              type: z.literal("resource_link"),
              uri: z.string().min(1),
              ...contentMetadata,
            })
            .strict(),
          z
            .object({
              type: z.literal("runtime_object"),
              objectId: z.string().uuid(),
              ...contentMetadata,
            })
            .strict(),
        ]),
      )
      .max(64)
      .optional(),
    readOnlyTurn: z.boolean().optional(),
  })
  .strict();

const ImmutablePromptRequestSchema = z
  .object({
    requestVersion: z.literal(2),
    command: z
      .object({
        id: z.string().uuid(),
        kind: z.literal("session.prompt"),
        issuedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    fence: z
      .object({
        hostKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        assignmentId: id,
        assignmentEpoch: z.number().int().min(1).max(2_147_483_647),
        runId: id,
      })
      .strict(),
    target: z.object({ hostSessionId: id }).strict(),
    payload: PromptPayloadSchema,
  })
  .strict();

export type ImmutablePromptRequest = z.infer<
  typeof ImmutablePromptRequestSchema
>;
export type StoredCommandRequest = Readonly<{
  requestSchema: typeof COMMAND_REQUEST_SCHEMA;
  requestCanonicalJson: string;
  requestSha256: string;
}>;

function invariant(reason: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "immutable command request failed validation",
    {
      details: { reason: "command_invariant_conflict", invariant: reason },
    },
  );
}

/** Private request normalization is performed once before admission. Unknown
 * transport fields, including resolved credentials, are refused by the schema.
 */
export function storePromptRequest(input: {
  envelope: CommandEnvelope<SendPromptInput>;
  targetSessionId: string;
}): StoredCommandRequest {
  const parsed = ImmutablePromptRequestSchema.safeParse({
    requestVersion: 2,
    ...input.envelope,
    target: { hostSessionId: input.targetSessionId },
  });

  if (!parsed.success) throw invariant("request_shape");
  try {
    // JSON wire semantics omit only validated optional undefined properties.
    const normalized: unknown = JSON.parse(JSON.stringify(parsed.data));
    const requestCanonicalJson = canonicalCommandJson(normalized);

    return {
      requestSchema: COMMAND_REQUEST_SCHEMA,
      requestCanonicalJson,
      requestSha256: createHash("sha256")
        .update(requestCanonicalJson, "utf8")
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof CommandJsonError) throw invariant("request_json");
    throw error;
  }
}

/** Verify original bytes and all routing bindings before replay. This value
 * stays inside the command delivery boundary; it must never enter a DTO/log.
 */
export function readPromptRequest(
  row: ExecutionCommand,
  hostKey: string,
): ImmutablePromptRequest {
  if (
    row.requestSchema !== COMMAND_REQUEST_SCHEMA ||
    !row.requestCanonicalJson ||
    !row.requestSha256
  )
    throw invariant("request_snapshot_missing");
  if (
    createHash("sha256")
      .update(row.requestCanonicalJson, "utf8")
      .digest("hex") !== row.requestSha256
  )
    throw invariant("request_digest");
  let value: unknown;

  try {
    value = JSON.parse(row.requestCanonicalJson);
    if (canonicalCommandJson(value) !== row.requestCanonicalJson)
      throw invariant("request_not_canonical");
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CommandJsonError)
      throw invariant("request_json");
    throw error;
  }
  const parsed = ImmutablePromptRequestSchema.safeParse(value);

  if (!parsed.success) throw invariant("request_shape");
  const request = parsed.data;

  if (
    request.command.id !== row.id ||
    request.command.kind !== row.kind ||
    request.command.issuedAt !== row.createdAt.toISOString() ||
    request.fence.runId !== row.runId ||
    request.fence.hostKey !== hostKey ||
    request.fence.assignmentId !== row.executionAssignmentId ||
    request.fence.assignmentEpoch !== row.assignmentEpoch ||
    request.target.hostSessionId !== row.targetSessionId
  )
    throw invariant("request_binding");

  return request;
}

/** Restore the branded transport envelope only after validating stored identity. */
export function promptEnvelopeFromCommand(
  row: ExecutionCommand,
  hostKey: string,
): CommandEnvelope<SendPromptInput> {
  return readPromptRequest(row, hostKey) as CommandEnvelope<SendPromptInput>;
}

export function classifyCommandRequest(
  row: Pick<
    ExecutionCommand,
    "requestSchema" | "requestCanonicalJson" | "requestSha256"
  >,
): "legacy_redacted" | "legacy_digest_only" | "v2_snapshot" | "invalid" {
  if (
    row.requestSchema === null &&
    row.requestCanonicalJson === null &&
    row.requestSha256 === null
  )
    return "legacy_redacted";
  if (row.requestSchema === COMMAND_REQUEST_SCHEMA)
    return row.requestCanonicalJson !== null && row.requestSha256 !== null
      ? "v2_snapshot"
      : "invalid";
  if (
    row.requestSchema !== null &&
    row.requestSha256 !== null &&
    row.requestCanonicalJson === null
  )
    return "legacy_digest_only";

  return "invalid";
}
