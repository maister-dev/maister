import "server-only";

import type { LocalPackage } from "@/lib/db/schema";

import pino from "pino";

import { appendFlowAssistantActionLog } from "./action-log";
import { validateFlowAssistantAction } from "./actions";
import {
  createRejectedActionResult,
  type FlowActionResultPayload,
  type FlowAssistantAction,
} from "./protocol";

import {
  deleteWorkingDirFile,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";

const log = pino({
  name: "studio/flow-assistant/apply",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ApplyFlowAssistantActionResult =
  | {
      ok: true;
      result: FlowActionResultPayload;
    }
  | {
      ok: false;
      result: FlowActionResultPayload;
    };

type ValidateAndApplyFlowAssistantActionArgs = {
  localPackage: LocalPackage;
  runId: string;
  action: FlowAssistantAction;
  assertCanApply: () => Promise<void>;
};

export async function validateAndApplyFlowAssistantAction(
  args: ValidateAndApplyFlowAssistantActionArgs,
): Promise<ApplyFlowAssistantActionResult> {
  await appendActionLog({
    ...args,
    state: "received",
  });

  const validation = await validateFlowAssistantAction(args);

  if (!validation.ok) {
    await appendActionLog({
      ...args,
      state: "rejected",
      result: validation.result,
    });

    return { ok: false, result: validation.result };
  }

  await appendActionLog({
    ...args,
    state: "validated",
    result: validation.result,
  });

  log.info(
    {
      localPackageId: args.localPackage.id,
      runId: args.runId,
      actionId: args.action.actionId,
      operationCount: args.action.operations.length,
    },
    "flow assistant action apply begin",
  );

  for (const [operationIndex, operation] of args.action.operations.entries()) {
    const lockFailure = await assertCanApplyBeforeOperation({
      applyArgs: args,
      operationIndex,
    });

    if (lockFailure !== null) return lockFailure;

    try {
      if (operation.op === "delete_file") {
        await deleteWorkingDirFile(args.localPackage, operation.path);
      } else {
        await writeWorkingDirFile(
          args.localPackage,
          operation.path,
          operation.content,
        );
      }
    } catch (err) {
      const result = createRejectedActionResult({
        actionId: args.action.actionId,
        status: "interrupted",
        summary: args.action.summary,
        operations: args.action.operations,
        issues: [`${operation.path}: ${asMessage(err)}`],
        message:
          "The action started applying but was interrupted. Inspect the package diff before continuing.",
      });

      await appendActionLog({
        ...args,
        state: "interrupted",
        result,
        operationIndex,
        message: asMessage(err),
      });

      log.error(
        {
          localPackageId: args.localPackage.id,
          runId: args.runId,
          actionId: args.action.actionId,
          operationIndex,
          path: operation.path,
          err: asMessage(err),
        },
        "flow assistant action apply interrupted",
      );

      return { ok: false, result };
    }
  }

  await appendActionLog({
    ...args,
    state: "applied",
    result: validation.result,
  });
  log.info(
    {
      localPackageId: args.localPackage.id,
      runId: args.runId,
      actionId: args.action.actionId,
      operationCount: args.action.operations.length,
    },
    "flow assistant action apply success",
  );

  return { ok: true, result: validation.result };
}

async function assertCanApplyBeforeOperation(args: {
  applyArgs: ValidateAndApplyFlowAssistantActionArgs;
  operationIndex: number;
}): Promise<ApplyFlowAssistantActionResult | null> {
  try {
    await args.applyArgs.assertCanApply();

    return null;
  } catch (err) {
    const firstOperation = args.operationIndex === 0;
    const result = createRejectedActionResult({
      actionId: args.applyArgs.action.actionId,
      status: firstOperation ? "rejected" : "interrupted",
      summary: args.applyArgs.action.summary,
      operations: args.applyArgs.action.operations,
      issues: [`editor lock: ${asMessage(err)}`],
      message: firstOperation
        ? "I did not change files because the editor lock was no longer held."
        : "The action started applying but the editor lock was lost. Inspect the package diff before continuing.",
    });

    await appendActionLog({
      localPackage: args.applyArgs.localPackage,
      runId: args.applyArgs.runId,
      action: args.applyArgs.action,
      state: firstOperation ? "rejected" : "interrupted",
      result,
      operationIndex: args.operationIndex,
      message: asMessage(err),
    });

    log.warn(
      {
        localPackageId: args.applyArgs.localPackage.id,
        runId: args.applyArgs.runId,
        actionId: args.applyArgs.action.actionId,
        operationIndex: args.operationIndex,
        status: result.status,
        err: asMessage(err),
      },
      "flow assistant action write lock lost",
    );

    return { ok: false, result };
  }
}

async function appendActionLog(args: {
  localPackage: LocalPackage;
  runId: string;
  state: "received" | "validated" | "applied" | "rejected" | "interrupted";
  action: FlowAssistantAction;
  result?: FlowActionResultPayload;
  operationIndex?: number;
  message?: string;
}): Promise<void> {
  try {
    await appendFlowAssistantActionLog({
      localPackageSlug: args.localPackage.slug,
      localPackageId: args.localPackage.id,
      runId: args.runId,
      state: args.state,
      action: args.action,
      result: args.result,
      operationIndex: args.operationIndex,
      message: args.message,
    });
  } catch (err) {
    log.warn(
      {
        localPackageId: args.localPackage.id,
        runId: args.runId,
        actionId: args.action.actionId,
        state: args.state,
        err: asMessage(err),
      },
      "flow assistant action log append failed",
    );
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
