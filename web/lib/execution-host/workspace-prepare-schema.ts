import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";
import {
  isWorkspaceAssignmentOwner,
  isWorkspaceGenerationTarget,
  isWorkspaceCancelTarget,
  isWorkspaceOperationOwner,
  isWorkspaceSourceRef,
  WORKSPACE_WORKLOAD_KINDS,
  type WorkspaceCancelTarget,
  type WorkspaceAssignmentOwner,
  type WorkspaceGenerationTarget,
  type WorkspaceOperationOwner,
} from "../../../runtime/workspace-prepare";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const handle = z.string().regex(/^ws_[a-f0-9]{32}$/);
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const gitObject = z.string().regex(GIT_OBJECT_ID);
export const WorkspacePublishPayloadSchema = z.object({
  generation,
  expected: z.object({
    head: gitObject,
    remoteId: opaqueId,
    targetRef: z.string().refine(isWorkspaceSourceRef),
    priorTarget: gitObject.nullable(),
  }).strict(),
  publication: z.enum(["push", "promote"]),
}).strict();
export const RetainedWorkspacePublishSchema = WorkspacePublishPayloadSchema.extend({
  claimId: z.string().uuid(),
  fence: generation,
});
export const WorkspaceEvidenceObjectSchema = z
  .object({
    generation,
    object: z.object({ objectId: z.string().uuid(), sha256: digest }).strict(),
    baseCommit: z.string().regex(GIT_OBJECT_ID).optional(),
    headCommit: z.string().regex(GIT_OBJECT_ID).optional(),
  })
  .strict();
export const WorkspaceReviewFingerprintSchema = z.object({ generation, baseCommit: gitObject, sha256: digest }).strict();
const mode = z.enum([
  "ownWorktree",
  "readOnlyCheckout",
  "sharedWorktree",
  "directory",
  "emptyDirectory",
]);

const WorkspaceRecordSchema = z
  .object({
    handle,
    generation,
    mode,
    observedCommit: gitObject.nullable(),
  })
  .strict();

export const WorkspaceStatusSchema = z
  .object({
    workspace: WorkspaceRecordSchema,
    workingTree: z.enum(["clean", "dirty", "nonGit"]),
    headState: z.enum(["branch", "detached", "nonGit"]),
  })
  .strict()
  .refine(({ workspace, workingTree, headState }) =>
    workspace.mode === "directory" || workspace.mode === "emptyDirectory"
      ? workspace.observedCommit === null &&
        workingTree === "nonGit" &&
        headState === "nonGit"
      : workspace.observedCommit !== null &&
        workingTree !== "nonGit" &&
        headState !== "nonGit",
  );

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
export const WorkspaceMaterializationPayloadSchema = z
  .object({
    generation,
    manifestDigest: digest,
    objects: z
      .array(z.object({ objectId: z.string().uuid(), sha256: digest }).strict())
      .min(1)
      .max(256),
  })
  .strict();

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
const materialization = {
  ...identity,
  operationId: z.literal("stageCMaterialize"),
  target: z.custom<WorkspaceGenerationTarget>(isWorkspaceGenerationTarget),
};
const terminalMaterialization = {
  ...terminal,
  ...materialization,
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
          workspace: WorkspaceRecordSchema,
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

export const WorkspaceMaterializationReceiptSchema = z.discriminatedUnion(
  "phase",
  [
    z
      .object({
        ...materialization,
        phase: z.literal("accepted"),
        status: z.literal(202),
        acceptance: WorkspacePrepareAcceptanceSchema,
      })
      .strict(),
    z
      .object({
        ...terminalMaterialization,
        phase: z.literal("completed"),
        result: z
          .object({
            generation,
            inputGeneration: generation,
            manifestDigest: digest,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...terminalMaterialization,
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
        ...terminalMaterialization,
        phase: z.literal("indeterminate"),
        condition: z.enum(["effect_unconfirmed", "quiescence_unconfirmed"]),
      })
      .strict(),
  ],
);

export const WorkspaceWorkloadPayloadSchema = z
  .object({
    generation,
    workload: z.enum(WORKSPACE_WORKLOAD_KINDS),
    declarationId: opaqueId,
    inputGeneration: generation,
    inputDigest: digest,
    templateContext: z.object({ objectId: z.string().uuid(), sha256: digest }).strict().optional(),
  })
  .strict();
export const WorkspaceCancelWorkloadPayloadSchema = z
  .object({ generation })
  .strict();
export const WorkspaceCheckpointPayloadSchema = z.object({ generation }).strict();
const CheckpointIdentitySchema = WorkspaceCheckpointPayloadSchema.extend({ checkpointId: z.string().uuid() });
export const WorkspaceRestorePayloadSchema = CheckpointIdentitySchema.extend({
  policy: z.literal("fresh-attempt").optional(),
});
export const WorkspaceGitCheckpointResultSchema = CheckpointIdentitySchema.extend({
  tree: gitObject,
  baseTree: gitObject.optional(),
  resultingTree: gitObject.optional(),
});
const workloadObject = z
  .object({ objectId: z.string().uuid(), sha256: digest })
  .strict();
export const WorkspaceWorkloadResultSchema = z
  .object({
    generation,
    processOutcome: z.enum([
      "exited",
      "signalled",
      "timedOut",
      "cancelled",
      "interrupted",
    ]),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .max(32)
      .nullable(),
    checkValidity: z.enum(["notRequested", "valid", "invalid", "unavailable"]),
    outputState: z.enum(["sealed", "truncated", "unavailable"]),
    objects: z.array(workloadObject).max(16),
    quiescence: z.enum(["proved", "uncertain"]),
  })
  .strict();
const cancellationResult = z
  .object({
    targetCommandId: z.string().uuid(),
    objects: z.array(workloadObject).max(16),
    quiescence: z.enum(["proved", "uncertain"]),
  })
  .strict();

function commandResultReceipt<
  Op extends "stageCRunWorkload" | "stageCCancelWorkload" | "stageCCheckpoint" | "stageCRestore" | "stageCPublish",
  T extends z.ZodType,
  R extends z.ZodType,
  O extends z.ZodType,
>(operationId: Op, target: T, result: R, owner: O) {
  const base = {
    ...materialization,
    operationId: z.literal(operationId),
    target,
    owner,
  };
  const terminal = {
    ...base,
    streamId: z.string().uuid(),
    eventId: z.string().uuid(),
    outcomeSha256: digest,
  };
  const refusal = z
    .object({
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(256),
      details: z.object({ reason: z.string().min(1).max(64) }).strict(),
    })
    .strict();

  return z.discriminatedUnion("phase", [
    z
      .object({
        ...base,
        phase: z.literal("accepted"),
        status: z.literal(202),
        acceptance: WorkspacePrepareAcceptanceSchema,
      })
      .strict(),
    z.object({ ...terminal, phase: z.literal("completed"), result }).strict(),
    z.object({ ...terminal, phase: z.literal("rejected"), refusal }).strict(),
    z
      .object({
        ...terminal,
        phase: z.literal("indeterminate"),
        condition: z.enum(["effect_unconfirmed", "quiescence_unconfirmed"]),
      })
      .strict(),
  ]);
}

const assignmentOwner = z.custom<WorkspaceAssignmentOwner>(isWorkspaceAssignmentOwner);
const workspaceTarget = z.custom<WorkspaceGenerationTarget>(isWorkspaceGenerationTarget);
export const WorkspaceCommandReceiptSchema = z.union([
  WorkspacePrepareReceiptSchema,
  WorkspaceMaterializationReceiptSchema,
  commandResultReceipt(
    "stageCRunWorkload",
    z.custom<WorkspaceGenerationTarget>(isWorkspaceGenerationTarget),
    WorkspaceWorkloadResultSchema,
    assignmentOwner,
  ),
  commandResultReceipt(
    "stageCCancelWorkload",
    z.custom<WorkspaceCancelTarget>(isWorkspaceCancelTarget),
    cancellationResult,
    assignmentOwner,
  ),
  commandResultReceipt("stageCCheckpoint", workspaceTarget, WorkspaceGitCheckpointResultSchema, assignmentOwner),
  commandResultReceipt("stageCRestore", workspaceTarget, WorkspaceGitCheckpointResultSchema, assignmentOwner),
  commandResultReceipt(
    "stageCPublish",
    workspaceTarget,
    z.object({
      publication: z.enum(["push", "promote"]),
      git: z.object({ generation, head: gitObject, priorTarget: gitObject.nullable(), observedTarget: gitObject }).strict(),
    }).strict(),
    z.custom<WorkspaceOperationOwner>(isWorkspaceOperationOwner),
  ),
]);
