import "server-only";

import type { AttemptReceipt, ProjectDependencyView } from "./view";
import type { getDb } from "@/lib/db/client";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { lockDependencyProject } from "./package-writes";
import { readProjectDeclarations } from "./read";
import {
  authorizeDependencySetupRecovery,
  inheritSetupRecovery,
} from "./setup";
import { assertDependencySource } from "./source";

import { packageEntrySchema } from "@/lib/config.schema";
import {
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const positiveInteger = z.number().int().positive();

export const editDependencySchema = packageEntrySchema
  .omit({ id: true })
  .extend({
    expectedGeneration: positiveInteger,
  })
  .strict();
export const retryDependencySchema = z
  .object({
    expectedGeneration: positiveInteger,
    expectedAttempt: positiveInteger,
  })
  .strict();
export const recoverDependencySchema = retryDependencySchema
  .extend({
    memberRef: z.string().min(1),
    resolvedRevision: z.string().min(1),
    action: z.literal("rerun_setup"),
  })
  .strict();

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
interface Target {
  projectId: string;
  declarationId: string;
  actorUserId: string;
}

function conflict(reason: string, message: string): never {
  throw new MaisterError("CONFLICT", message, { details: { reason } });
}

async function lockHead(tx: Tx, target: Target, expectedGeneration: number) {
  await lockDependencyProject(tx, target.projectId);
  const [head] = await tx
    .select()
    .from(declarations)
    .where(
      and(
        eq(declarations.projectId, target.projectId),
        eq(declarations.id, target.declarationId),
      ),
    )
    .for("update");

  if (!head) return null;
  if (head.generation !== expectedGeneration)
    conflict(
      "stale_generation",
      "The requested pin changed. Refresh its current generation.",
    );

  return head;
}

export function editDependency(
  db: Db,
  target: Target,
  input: z.infer<typeof editDependencySchema>,
): Promise<ProjectDependencyView | null> {
  return db.transaction(async (tx) => {
    const head = await lockHead(tx, target, input.expectedGeneration);

    if (!head) return null;
    if (head.kind !== "package")
      throw new MaisterError("CONFIG", "Only a package pin can be edited.");
    assertDependencySource(input.source);

    if (
      head.desired.source !== input.source ||
      head.desired.version !== input.version ||
      head.desired.path !== input.path
    ) {
      const desired = {
        ...head.desired,
        source: input.source,
        version: input.version,
        path: input.path,
      };
      const generation = head.generation + 1;

      await tx
        .update(declarations)
        .set({ desired, generation })
        .where(eq(declarations.id, head.id));
      await tx.insert(attempts).values({
        projectId: target.projectId,
        declarationId: head.id,
        generation,
        attemptNo: 1,
        desired,
        actorUserId: target.actorUserId,
        status: "pending",
      });
    }

    const [view] = await readProjectDeclarations(
      tx,
      target.projectId,
      true,
      target.declarationId,
    );

    return view!;
  });
}

type ResubmitInput =
  | z.infer<typeof retryDependencySchema>
  | z.infer<typeof recoverDependencySchema>;

export function resubmitDependency(
  db: Db,
  target: Target,
  input: ResubmitInput,
): Promise<AttemptReceipt | null> {
  return db.transaction(async (tx) => {
    const head = await lockHead(tx, target, input.expectedGeneration);

    if (!head) return null;
    const generationScope = and(
      eq(attempts.declarationId, head.id),
      eq(attempts.generation, head.generation),
    );
    const [original] = await tx
      .select()
      .from(attempts)
      .where(
        and(generationScope, eq(attempts.attemptNo, input.expectedAttempt)),
      )
      .for("update");

    if (!original)
      conflict(
        "stale_attempt",
        "The referenced attempt does not exist in this generation.",
      );
    const recovering = "action" in input;

    if (
      recovering &&
      (original.memberRef !== input.memberRef ||
        original.resolvedRevision !== input.resolvedRevision)
    )
      conflict("stale_attempt", "The setup member or revision changed.");
    if (original.status !== (recovering ? "recovery_required" : "failed"))
      conflict(
        "ineligible_state",
        "This attempt does not permit the requested action.",
      );

    const receipt = (attempt: number): AttemptReceipt => ({
      declarationId: head.id,
      generation: head.generation,
      attempt,
    });
    const [accepted] = await tx
      .select({ attempt: attempts.attemptNo })
      .from(attempts)
      .where(eq(attempts.retryOfAttemptId, original.id));

    if (accepted) return receipt(accepted.attempt);
    const [latest] = await tx
      .select({ attempt: attempts.attemptNo })
      .from(attempts)
      .where(generationScope)
      .orderBy(desc(attempts.attemptNo))
      .limit(1);

    if (latest?.attempt !== original.attemptNo)
      conflict("stale_attempt", "Refresh the latest failed attempt.");
    assertDependencySource(head.desired.source);
    let continueSetup = recovering;

    if (recovering) {
      await authorizeDependencySetupRecovery(tx, original.id);
    } else if (original.checkpoint.setupMaterialKey) {
      continueSetup = await inheritSetupRecovery(tx, original);
    }

    const attempt = original.attemptNo + 1;

    await tx.insert(attempts).values({
      declarationId: head.id,
      projectId: target.projectId,
      generation: head.generation,
      attemptNo: attempt,
      retryOfAttemptId: original.id,
      actorUserId: target.actorUserId,
      desired: head.desired,
      status: "pending",
      ...(continueSetup
        ? {
            checkpoint: original.checkpoint,
            memberRef: original.memberRef,
            resolvedRevision: original.resolvedRevision,
          }
        : {}),
    });

    return receipt(attempt);
  });
}
