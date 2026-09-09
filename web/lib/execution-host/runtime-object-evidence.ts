import "server-only";

import type { Db } from "./db";
import type { RuntimeObjectWireMetadata } from "@/lib/supervisor-client";
import type { ExecutionRuntimeObject } from "@/lib/db/schema";
import type { RuntimeObjectState } from "./types";

import { eq } from "drizzle-orm";
import pino from "pino";

import { executionRuntimeObjects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const logger = pino({
  name: "runtime-object-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

export type RuntimeObjectBinding = {
  objectId: string;
  runId: string;
  executionHostId: string;
  executionAssignmentId: string;
  assignmentEpoch: number;
  generation: number;
};

export type RuntimeObjectSeal = Pick<
  RuntimeObjectWireMetadata,
  | "objectId"
  | "generation"
  | "kind"
  | "logicalName"
  | "mimeType"
  | "retentionClass"
  | "expiresAt"
  | "sizeBytes"
  | "sha256"
  | "sealedAt"
  | "state"
>;

type SealEvidence = { kind: "seal"; metadata: RuntimeObjectSeal } & (
  | { source: "ack" }
  | { source: "event"; eventId: string }
);
type StateEvidence = {
  kind: "state";
  state: RuntimeObjectState;
  deletedAt: Date | null;
} & (
  | { source: "delete_intent" | "delete_ack" }
  | { source: "event"; eventId: string }
);
type Evidence = SealEvidence | StateEvidence;
type ObjectChange = Partial<
  Pick<
    ExecutionRuntimeObject,
    | "sizeBytes"
    | "sha256"
    | "sealedAt"
    | "state"
    | "sourceEventId"
    | "deletedAt"
    | "lastError"
  >
>;
type ConflictReason =
  | "intent_missing"
  | "identity_conflict"
  | "seal_invalid"
  | "declaration_conflict"
  | "seal_conflict"
  | "transition_conflict";

export class RuntimeObjectEvidenceError extends MaisterError {
  constructor(readonly reason: ConflictReason) {
    super(
      "CONFLICT",
      "runtime object evidence conflicts with its durable intent",
      {
        details: { reason: "command_invariant_conflict", objectReason: reason },
      },
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function runtimeObjectBindingMatches(
  object: ExecutionRuntimeObject,
  binding: RuntimeObjectBinding,
): boolean {
  return (
    object.id === binding.objectId &&
    object.runId === binding.runId &&
    object.executionHostId === binding.executionHostId &&
    object.executionAssignmentId === binding.executionAssignmentId &&
    object.assignmentEpoch === binding.assignmentEpoch &&
    object.generation === binding.generation
  );
}

function sealChange(
  object: ExecutionRuntimeObject,
  evidence: SealEvidence,
): ObjectChange {
  const metadata = evidence.metadata;
  const sealedAt =
    metadata.sealedAt === null ? null : new Date(metadata.sealedAt);
  const expiresAt =
    metadata.expiresAt === null ? null : new Date(metadata.expiresAt);

  if (
    metadata.state !== "available" ||
    metadata.sizeBytes === null ||
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes < 0 ||
    metadata.sha256 === null ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    !sealedAt ||
    !Number.isFinite(sealedAt.getTime()) ||
    (expiresAt !== null && !Number.isFinite(expiresAt.getTime()))
  ) {
    throw new RuntimeObjectEvidenceError("seal_invalid");
  }
  if (
    metadata.objectId !== object.id ||
    metadata.generation !== object.generation ||
    metadata.kind !== object.kind ||
    metadata.logicalName !== object.logicalName ||
    metadata.mimeType !== object.mimeType ||
    metadata.retentionClass !== object.retentionClass ||
    expiresAt?.getTime() !== object.expiresAt?.getTime()
  ) {
    throw new RuntimeObjectEvidenceError("identity_conflict");
  }
  const sizeBytes = BigInt(metadata.sizeBytes);

  if (
    (object.declaredSizeBytes !== null &&
      object.declaredSizeBytes !== sizeBytes) ||
    (object.declaredSha256 !== null &&
      object.declaredSha256 !== metadata.sha256)
  ) {
    throw new RuntimeObjectEvidenceError("declaration_conflict");
  }
  if (
    (object.sizeBytes !== null && object.sizeBytes !== sizeBytes) ||
    (object.sha256 !== null && object.sha256 !== metadata.sha256) ||
    (object.sealedAt !== null &&
      object.sealedAt.getTime() !== sealedAt.getTime())
  ) {
    throw new RuntimeObjectEvidenceError("seal_conflict");
  }

  // Later evidence may confirm an old seal; only pending can gain availability.
  // In particular, ACKs and replayed available events never undo a tombstone.
  return {
    sizeBytes,
    sha256: metadata.sha256,
    sealedAt,
    ...(evidence.source === "event" &&
    (object.state === "pending" ||
      (object.state === "available" && object.sourceEventId === null))
      ? { state: "available", sourceEventId: evidence.eventId }
      : {}),
  };
}

function stateChange(
  object: ExecutionRuntimeObject,
  evidence: StateEvidence,
): ObjectChange {
  if (
    evidence.state === "pending" ||
    evidence.state === object.state ||
    object.state === "deleted"
  )
    return {};
  if (evidence.state === "available")
    throw new RuntimeObjectEvidenceError("transition_conflict");
  if (object.state === "deleting" && evidence.state !== "deleted") return {};
  if (
    object.state !== "available" &&
    evidence.state !== "deleting" &&
    evidence.state !== "deleted"
  )
    return {};
  if (object.sealedAt === null)
    throw new RuntimeObjectEvidenceError("transition_conflict");

  return {
    state: evidence.state,
    ...(evidence.source === "event" ? { sourceEventId: evidence.eventId } : {}),
    ...(evidence.state === "deleted"
      ? { deletedAt: object.deletedAt ?? evidence.deletedAt, lastError: null }
      : {}),
  };
}

/** Apply exact native intent evidence under the same object lock for every arrival order. */
export async function reduceRuntimeObjectEvidence(
  tx: Db,
  binding: RuntimeObjectBinding,
  evidence: Evidence,
): Promise<void> {
  const fields = {
    ...binding,
    evidenceSource: evidence.source,
    evidenceKind: evidence.kind,
  };

  try {
    const [object] = await tx
      .select()
      .from(executionRuntimeObjects)
      .where(eq(executionRuntimeObjects.id, binding.objectId))
      .for("update")
      .limit(1);

    if (!object) throw new RuntimeObjectEvidenceError("intent_missing");
    if (!runtimeObjectBindingMatches(object, binding))
      throw new RuntimeObjectEvidenceError("identity_conflict");
    const change =
      evidence.kind === "seal"
        ? sealChange(object, evidence)
        : stateChange(object, evidence);

    if (Object.keys(change).length > 0)
      await tx
        .update(executionRuntimeObjects)
        .set(change)
        .where(eq(executionRuntimeObjects.id, object.id));
    logger.debug(fields, "runtime-object-evidence-reconciled");
  } catch (error) {
    if (error instanceof RuntimeObjectEvidenceError)
      logger.warn(
        { ...fields, conflictReason: error.reason },
        "runtime-object-evidence-refused",
      );
    throw error;
  }
}
