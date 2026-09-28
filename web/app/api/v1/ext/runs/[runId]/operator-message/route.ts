import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { sendAgentMessage } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import { librarianOperations, runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { refreshSucceededLibrarianReceipt } from "@/lib/librarian/operations";
import { sendScratchUserMessage } from "@/lib/scratch-runs/service";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { handleExt, httpStatusForExtCode, recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { runProjectResolver } from "@/lib/tokens/run-project";

const ENDPOINT = "POST /api/v1/ext/runs/[runId]/operator-message";
const bodySchema = z.object({ message: z.string().min(1).max(60_000) }).strict();
const log = pino({ name: "librarian.operator-message", level: process.env.LOG_LEVEL ?? "info" });
type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { runId } = await params;
  const db = getDb();

  return handleExt(req, {
    scopeLabel: "runs:message",
    endpoint: ENDPOINT,
    method: "POST",
    admitLibrarian: true,
    resolveLibrarianProjectId: runProjectResolver(runId),
    successAuditInWork: true,
    idempotency: {
      kind: "run_operator_message",
      target: { runId },
      parseBody: async (request) => bodySchema.parse(await request.json()),
    },
    db,
  }, async (ctx) => {
    if (!ctx.actor.ownerUserId) {
      return NextResponse.json({ code: "UNAUTHORIZED", message: "operator message requires a user owner" }, { status: 403 });
    }

    let body: z.infer<typeof bodySchema>;

    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      return NextResponse.json({ code: "CONFIG", message: `invalid body: ${(err as Error).message}` }, { status: 422 });
    }

    const [run] = await db.select({ id: runs.id, runKind: runs.runKind, createdByUserId: runs.createdByUserId }).from(runs).where(
      and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)),
    );

    if (!run) {
      return NextResponse.json({ code: "NOT_FOUND", message: "run not found" }, { status: 404 });
    }
    if (run.runKind === "scratch" && run.createdByUserId !== ctx.actor.ownerUserId) {
      return NextResponse.json({ code: "NOT_FOUND", message: "run not found" }, { status: 404 });
    }

    const auditAccepted = async (tx: unknown, receipt: Record<string, unknown>): Promise<void> => {
      await recordRequiredTokenAudit({
        ...tokenAuditIdentity(ctx.actor),
        projectId: ctx.projectId,
        scopeUsed: "runs:message",
        endpoint: ENDPOINT,
        method: "POST",
        result: "ok",
        statusCode: 202,
        operationId: ctx.operationId,
        operation: ctx.operationId
          ? { id: ctx.operationId, result: { statusCode: 202, body: receipt } }
          : undefined,
      }, tx);
    };

    try {
      if (run.runKind === "flow") {
        const receipt = {
          runId,
          outcome: "refused_requires_rework",
          reason: "Use the run's node interrupt or rework controls to change an active Flow.",
        };

        await db.transaction(async (tx) => auditAccepted(tx, receipt));
        log.info({ runId, runKind: run.runKind, outcome: receipt.outcome }, "operator message outcome");

        return NextResponse.json(receipt, { status: 202 });
      }

      if (run.runKind === "scratch") {
        const sent = await sendScratchUserMessage({
          runId,
          body: { content: body.message, attachments: [] },
          operatorUserId: ctx.actor.ownerUserId,
          viaOperationId: ctx.operationId,
          recordAccepted: async (tx, messageId) => auditAccepted(tx, { runId, messageId, outcome: "queued" }),
        });
        const receipt = {
          runId,
          messageId: sent.messageId,
          outcome: sent.delivery === "queued" ? "queued" : "delivered",
        };

        if (ctx.operationId) {
          await refreshSucceededLibrarianReceipt({ id: ctx.operationId, result: { statusCode: 202, body: receipt } }, db);
        }
        log.info({ runId, runKind: run.runKind, outcome: receipt.outcome }, "operator message outcome");

        return NextResponse.json(receipt, { status: 202 });
      }

      if (run.runKind === "agent") {
        const sent = await sendAgentMessage(runId, body.message, {
          db,
          requestKey: ctx.operationId,
          requestedByUserId: ctx.actor.ownerUserId,
          recordAccepted: async (tx, turn) => auditAccepted(tx, { runId, messageId: turn.id, outcome: "queued" }),
        });
        const receipt = {
          runId,
          messageId: sent.messageId,
          outcome: sent.delivery === "queued" ? "queued" : "delivered",
        };

        if (ctx.operationId) {
          await refreshSucceededLibrarianReceipt({ id: ctx.operationId, result: { statusCode: 202, body: receipt } }, db);
        }
        log.info({ runId, runKind: run.runKind, outcome: receipt.outcome }, "operator message outcome");

        return NextResponse.json(receipt, { status: 202 });
      }

      return NextResponse.json({ code: "PRECONDITION", message: "run kind cannot receive operator messages" }, { status: 409 });
    } catch (err) {
      if (ctx.operationId) {
        const [operation] = await db.select({
          status: librarianOperations.status,
          result: librarianOperations.result,
        }).from(librarianOperations).where(eq(librarianOperations.id, ctx.operationId));

        const storedResult = z.object({
          statusCode: z.number().int(),
          body: z.record(z.string(), z.unknown()),
        }).safeParse(operation?.result);

        if (operation?.status === "succeeded" && storedResult.success) {
          log.warn({ runId, operationId: ctx.operationId, error: err }, "operator message delivery failed after acceptance");

          return NextResponse.json(storedResult.data.body, { status: storedResult.data.statusCode });
        }
      }
      if (!isMaisterError(err)) throw err;

      return NextResponse.json({ code: err.code, message: err.message, details: err.details }, {
        status: httpStatusForExtCode(err.code),
      });
    }
  });
}
