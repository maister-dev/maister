import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExtCtx,
  ExtOperationContinuation,
} from "@/lib/tokens/ext-handler";
import type { TaskLaunchAuditContext } from "./launch-intent";
import type { TaskLaunchRequest } from "./launch-schema";
import type { TokenTaskLaunchPrincipal } from "./launch-token";
import type { TaskLaunchReceipt } from "./launch-types";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { readTaskLaunchBody, taskLaunchErrorResponse } from "./launch-http";
import { taskLaunchBodySchema } from "./launch-schema";
import { tokenTaskLaunchPrincipal } from "./launch-token";
import { taskLaunchForTokenWrite } from "./launch-access";
import { taskLaunchReceipt } from "./launch-receipt";
import { launchRefusal } from "./launch-resolution";

import { tasks, taskLaunchIntents, librarianOperations } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { TokenAuthError, httpStatusForTokenAuth } from "@/lib/tokens/verify";
import { refuseLibrarianOperation } from "@/lib/librarian/operations";
import { pgErrorOf, queryErrorDiagnostics } from "@/lib/db/pg-error";

const log = pino({
  name: "task-launch-external",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function readExternalTaskLaunchBody(
  request: Request,
): Promise<TaskLaunchRequest> {
  const parsed = taskLaunchBodySchema.safeParse(
    await readTaskLaunchBody(request),
  );

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Task launch body is invalid", {
      details: { reason: "launch_request_invalid" },
    });

  return parsed.data;
}

export async function externalTaskLaunchProject(
  db: Db,
  taskId: string,
): Promise<string | null> {
  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  return task?.projectId ?? null;
}

export async function externalTaskLaunchIntentProject(
  db: Db,
  intentId: string,
): Promise<string | null> {
  const [intent] = await db
    .select({ projectId: taskLaunchIntents.projectId })
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  return intent?.projectId ?? null;
}

/** The generic external handler's actor is attribution, never a launch capability. */
export async function externalTaskLaunchPrincipal(
  db: Db,
  request: Request,
  context: ExtCtx,
): Promise<TokenTaskLaunchPrincipal> {
  const match = /^Bearer (.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );

  if (!match) throw new TokenAuthError("invalid");
  const principal = await tokenTaskLaunchPrincipal(db, match[1]);
  const actor = context.actor;
  const expected = {
    version: 1,
    kind: "token",
    tokenId: actor.tokenId,
    tokenKind: actor.tokenKind,
    projectId: actor.projectId,
    ownerUserId: actor.ownerUserId,
    agentId: actor.agentId,
    boundRunId: actor.boundRunId,
    librarianTurnId: actor.librarianTurnId ?? null,
  };

  if (retryDigest(principal.origin) !== retryDigest(expected))
    throw new MaisterError("UNAUTHORIZED", "Token launch identity changed", {
      details: { reason: "launch_authority_revoked" },
    });

  return principal;
}

export function externalTaskLaunchAudit(
  context: ExtCtx,
  endpoint: string,
): TaskLaunchAuditContext {
  return {
    recordSuccessAudit: async (db, receipt) => {
      let admittedOperationId: string | undefined;

      if (context.operationId) {
        const [operation] = await db
          .select()
          .from(librarianOperations)
          .where(eq(librarianOperations.id, context.operationId))
          .for("update");

        if (!operation) throw launchRefusal("launch_state_changed");
        if (operation.status === "admitted") admittedOperationId = operation.id;
        else if (
          operation.status !== "succeeded" ||
          operation.result?.statusCode !== 202 ||
          typeof operation.result.body !== "object" ||
          operation.result.body === null ||
          !("intentId" in operation.result.body) ||
          operation.result.body.intentId !== receipt.intentId
        )
          throw launchRefusal("launch_state_changed");
      }
      await recordRequiredTokenAudit(
        {
          ...tokenAuditIdentity(context.actor),
          projectId: context.projectId,
          scopeUsed: "runs:launch",
          endpoint,
          method: "POST",
          result: "ok",
          statusCode: 202,
          operationId: context.operationId,
          operation: admittedOperationId
            ? {
                id: admittedOperationId,
                result: { statusCode: 202, body: receipt },
              }
            : undefined,
        },
        db,
      );
    },
  };
}

/** Re-enter admitted database-only work; completed effects are read through current authority. */
export function externalTaskLaunchContinuation(
  db: Db,
  request: Request,
  work: (context: ExtCtx) => Promise<NextResponse>,
): ExtOperationContinuation {
  return {
    replay: async (operation, context) => {
      if (operation.status === "admitted") return work(context);
      if (operation.status === "succeeded") {
        try {
          const body = operation.result?.body;

          if (typeof body?.intentId !== "string")
            throw launchRefusal("launch_state_changed");
          const intentId = body.intentId;
          const principal = await externalTaskLaunchPrincipal(
            db,
            request,
            context,
          );
          const receipt = await db.transaction(async (tx) => {
            const intent = await taskLaunchForTokenWrite(
              tx,
              intentId,
              principal,
            );

            if (intent.projectId !== context.projectId)
              throw launchRefusal("launch_not_found", "PRECONDITION");
            const current = taskLaunchReceipt(intent);

            await externalTaskLaunchAudit(
              context,
              "POST /api/v1/ext/task-launch-intents",
            ).recordSuccessAudit(tx, current);

            return current;
          });

          return externalTaskLaunchReceiptResponse(receipt);
        } catch (error) {
          return externalTaskLaunchErrorResponse(error);
        }
      }
      if (operation.result && operation.result.statusCode >= 400)
        return NextResponse.json(operation.result.body, {
          status: operation.result.statusCode,
          headers: { "Cache-Control": "no-store" },
        });

      return externalTaskLaunchErrorResponse(
        launchRefusal("launch_operation_requires_reconciliation"),
      );
    },
    refuse: async (operationId, response, tx) => {
      // A transient response cannot establish the outcome; the durable key owns recovery.
      if (response.status === 503) return;
      const body = (await response.clone().json()) as Record<string, unknown>;

      await refuseLibrarianOperation(
        {
          id: operationId,
          errorCode: typeof body.code === "string" ? body.code : "PRECONDITION",
          statusCode: response.status,
          body,
        },
        tx,
      );
    },
  };
}

export function externalTaskLaunchReceiptResponse(
  receipt: TaskLaunchReceipt,
): NextResponse {
  return NextResponse.json(receipt, {
    status: 202,
    headers: {
      Location: `/api/v1/ext/task-launch-intents/${receipt.intentId}`,
      "Cache-Control": "no-store",
    },
  });
}

function retryableLaunchStorageFailure(error: unknown): boolean {
  const pg = pgErrorOf(error);

  if (
    pg &&
    (pg.code.startsWith("08") ||
      [
        "40001",
        "40P01",
        "55P03",
        "57P01",
        "57P02",
        "57P03",
        "53300",
        "53400",
      ].includes(pg.code))
  )
    return true;
  let current: unknown = error;

  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const candidate = current as { code?: unknown; cause?: unknown };

    if (
      typeof candidate.code === "string" &&
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(
        candidate.code,
      )
    )
      return true;
    current = candidate.cause;
  }

  return false;
}

export function externalTaskLaunchErrorResponse(error: unknown): NextResponse {
  if (retryableLaunchStorageFailure(error)) {
    log.warn(queryErrorDiagnostics(error), "task-launch-storage-unavailable");

    return NextResponse.json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message:
          "Launch storage is unavailable; retry with the same Idempotency-Key",
        details: { reason: "launch_storage_unavailable" },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof TokenAuthError) {
    const status = httpStatusForTokenAuth(error.kind);

    return NextResponse.json(
      {
        code: status === 401 ? "UNAUTHENTICATED" : "UNAUTHORIZED",
        message: "Token launch authority is unavailable",
      },
      { status },
    );
  }
  const response = taskLaunchErrorResponse(error);

  if (isMaisterError(error) && error.code === "CONFIG")
    return new NextResponse(response.body, {
      status: 422,
      headers: response.headers,
    });

  return response;
}
