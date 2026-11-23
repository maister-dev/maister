import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";
import {
  isWorkspaceAssignmentOwner,
  type WorkspaceAssignmentOwner,
} from "../../../runtime/workspace-prepare";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const handle = z.string().regex(/^ws_[a-f0-9]{32}$/);
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const gitObject = z.string().regex(GIT_OBJECT_ID);
const mode = z.enum([
  "ownWorktree",
  "readOnlyCheckout",
  "sharedWorktree",
  "directory",
  "emptyDirectory",
]);

export const WorkspacePreparePayloadSchema = z.union([
  z
    .object({
      mode: z.enum(["ownWorktree", "readOnlyCheckout"]),
      repositoryId: opaqueId,
      commit: gitObject,
      inputDigest: digest,
    })
    .strict(),
  z
    .object({
      mode: z.literal("sharedWorktree"),
      parentHandle: handle,
      parentGeneration: generation,
      inputDigest: digest,
    })
    .strict(),
  z
    .object({
      mode: z.literal("directory"),
      directoryProfileId: opaqueId,
      inputDigest: digest,
    })
    .strict(),
  z.object({ mode: z.literal("emptyDirectory"), inputDigest: digest }).strict(),
]);

export const WorkspacePrepareAcceptanceSchema = z
  .object({
    commandId: z.string().uuid(),
    state: z.literal("accepted"),
  })
  .strict();

const identity = {
  commandId: z.string().uuid(),
  requestSha256: digest,
  operationId: z.literal("stageCPrepare"),
  owner: z.custom<WorkspaceAssignmentOwner>(isWorkspaceAssignmentOwner),
  target: z.object({ kind: z.literal("prepare") }).strict(),
};
const terminal = {
  ...identity,
  streamId: z.string().uuid(),
  eventId: z.string().uuid(),
  outcomeSha256: digest,
};

export const WorkspacePrepareReceiptSchema = z.discriminatedUnion("phase", [
  z
    .object({
      ...identity,
      phase: z.literal("accepted"),
      status: z.literal(202),
      acceptance: WorkspacePrepareAcceptanceSchema,
    })
    .strict(),
  z
    .object({
      ...terminal,
      phase: z.literal("completed"),
      result: z
        .object({
          workspace: z
            .object({
              handle,
              generation,
              mode,
              observedCommit: gitObject.nullable(),
            })
            .strict(),
          inputDigest: digest,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...terminal,
      phase: z.literal("rejected"),
      refusal: z
        .object({
          code: z.string().min(1).max(64),
          message: z.string().min(1).max(256),
          details: z.object({ reason: z.string().min(1).max(64) }).strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...terminal,
      phase: z.literal("indeterminate"),
      condition: z.enum(["effect_unconfirmed", "quiescence_unconfirmed"]),
    })
    .strict(),
]);
