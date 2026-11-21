import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { runWaitActions, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { waitSignalBody } from "@/lib/waits/http";
import { queueConditionWaitResume } from "@/lib/waits/lifecycle";
import {
  encodeWaitDigest,
  extendWaitDeadlineInTransaction,
  lockWait,
  normalizeWaitIdempotencyKey,
  readWaitClock,
  recordWaitSignalInTransaction,
  signalWaitOutcomes,
  waitConflict,
  type WaitAddress,
  type WaitDb,
  type WaitRow,
} from "@/lib/waits/store";

const actionBase = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((reason) => !reason.includes("\0")),
});

export const operatorWaitBody = z.discriminatedUnion("action", [
  actionBase
    .extend({ action: z.literal("deliver_signal"), signal: waitSignalBody })
    .strict(),
  actionBase
    .extend({
      action: z.literal("resolve_now"),
      outcome: z.string().min(1).max(64),
    })
    .strict(),
  actionBase
    .extend({
      action: z.literal("extend"),
      deadline: z.iso.datetime({ offset: true }),
    })
    .strict(),
  actionBase.extend({ action: z.literal("cancel") }).strict(),
]);
type OperatorCommand = z.infer<typeof operatorWaitBody>;
type OperatorAction = OperatorCommand["action"];

export function allowedWaitActions(wait: WaitRow, now: Date): OperatorAction[] {
  if (wait.state !== "open" || !wait.deadlineAt || wait.deadlineAt <= now)
    return [];
  const actions: OperatorAction[] = ["resolve_now", "cancel"];

  if (signalWaitOutcomes(wait).length > 0) actions.unshift("deliver_signal");
  if (wait.absoluteCapAt && wait.deadlineAt < wait.absoluteCapAt)
    actions.push("extend");

  return actions;
}

export async function operateWait(
  db: WaitDb,
  address: WaitAddress,
  identity: { userId: string; key: string },
  command: OperatorCommand,
) {
  const idempotencyKey = normalizeWaitIdempotencyKey(identity.key);

  const actionReceiptId = encodeWaitDigest([
    address.waitId,
    identity.userId,
    idempotencyKey,
  ]);
  const payloadDigest = encodeWaitDigest(command);

  const result = await db.transaction(async (tx) => {
    await assertTaskLaunchUserAuthority(
      tx,
      address.projectId,
      identity.userId,
      ["operateWait"],
    );
    const [owner] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(
        and(eq(runs.id, address.runId), eq(runs.projectId, address.projectId)),
      )
      .for("update");

    if (command.action === "extend") {
      const body = await extendWaitDeadlineInTransaction(tx, {
        ...address,
        ...command,
        userId: identity.userId,
        idempotencyKey,
        deadline: new Date(command.deadline),
      });

      return { body, status: 200, rejection: null };
    }
    const wait = await lockWait(tx, address);
    const [prior] = await tx
      .select()
      .from(runWaitActions)
      .where(eq(runWaitActions.id, actionReceiptId));

    if (prior) {
      if (prior.payloadDigest !== payloadDigest)
        throw waitConflict(address, "wait_key_conflict");

      const rejection =
        prior.action === "deliver_signal" &&
        prior.response &&
        typeof prior.response === "object" &&
        !Array.isArray(prior.response)
          ? prior.response.rejection
          : null;

      return {
        status: prior.action === "deliver_signal" ? 202 : 200,
        body: prior.response,
        rejection: typeof rejection === "string" ? rejection : null,
      };
    }

    if (wait.state !== "open" || owner?.status !== "Waiting")
      throw waitConflict(address, "wait_closed");
    if (wait.version !== command.expectedVersion)
      throw waitConflict(address, "wait_version_changed");
    const now = await readWaitClock(tx);

    if (wait.deadlineAt && wait.deadlineAt <= now)
      throw waitConflict(address, "wait_deadline_elapsed");
    if (!allowedWaitActions(wait, now).includes(command.action))
      throw waitConflict(address, "wait_closed");

    let body;
    let rejection: string | null = null;
    let status = 200;
    let resultingVersion = wait.version;

    if (command.action === "deliver_signal") {
      const receipt = await recordWaitSignalInTransaction(tx, {
        ...address,
        actor: { kind: "operator", id: identity.userId },
        idempotencyKey,
        signal: command.signal,
      });

      rejection = receipt.reason;
      body = {
        receiptId: receipt.receiptId,
        waitId: receipt.waitId,
        disposition: receipt.disposition,
        application: receipt.application,
        ...(rejection ? { rejection } : {}),
      };
      status = 202;
    } else {
      const outcome =
        command.action === "cancel" ? "cancelled" : command.outcome;

      if (!wait.condition.outcomes.includes(outcome))
        throw new MaisterError("CONFIG", "Wait outcome is not declared", {
          details: { reason: "wait_invalid_payload" },
        });

      await queueConditionWaitResume(tx, address, wait.version, {
        source: "operator",
        sourceId: actionReceiptId,
        outcome,
      });
      resultingVersion++;
      body = {
        actionReceiptId,
        version: resultingVersion,
        state: "resolved",
        outcome,
      };
    }

    await tx.insert(runWaitActions).values({
      id: actionReceiptId,
      waitId: wait.id,
      userId: identity.userId,
      idempotencyKey,
      payloadDigest,
      action: command.action,
      reason: command.reason,
      expectedVersion: command.expectedVersion,
      resultingVersion,
      response: body,
      createdAt: now,
    });

    return { status, body, rejection };
  });

  if (result.rejection) throw waitConflict(address, result.rejection);

  return { status: result.status, body: result.body };
}
