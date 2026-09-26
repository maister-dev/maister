import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { librarianTaskLinks, librarianTurns, taskStatementRevisions } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { listLaunchableFlowSummaries } from "@/lib/queries/project";
import { recordTaskActivity } from "@/lib/social/activity";
import { renderStatementPrompt, taskStatementSchema } from "@/lib/tasks/statement";
import { createTask } from "@/lib/services/tasks";
import { listTaskDTOs } from "@/lib/services/tasks";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { resolveProducingRunId } from "@/lib/agents/chain-depth";
import { socialActorForToken, actorUserIdForToken } from "@/lib/tokens/verify";

const ENDPOINT_TASKS = "POST /api/v1/ext/projects/[slug]/tasks";
const ENDPOINT_TASKS_GET = "GET /api/v1/ext/projects/[slug]/tasks";

const postBodySchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1).optional(),
    statement: taskStatementSchema.optional(),
    // M34 (ADR-089): optional — simple-intent creation; the task classifies
    // as `unconfigured` until triage (or a human) fills the flow.
    flowId: z.string().min(1).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };
type TransactionalDb = {
  transaction<T>(scope: (tx: unknown) => Promise<T>): Promise<T>;
};

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:create",
      admitLibrarian: true,
      endpoint: ENDPOINT_TASKS,
      method: "POST",
      successAuditInWork: true,
      idempotency: {
        kind: "task_create",
        target: { slug },
        parseBody: async (request) => postBodySchema.parse(await request.json()),
      },
      db,
    },
    async (ctx) => {
      // Authenticate first (handleExt above), then validate the body.
      let body: z.infer<typeof postBodySchema>;

      try {
        body = postBodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      const librarian = ctx.actor.tokenKind === "librarian";

      if (librarian && !body.statement) {
        return NextResponse.json({ code: "CONFIG", message: "a librarian task requires a statement" }, { status: 422 });
      }
      if (!librarian && !body.prompt) {
        return NextResponse.json({ code: "CONFIG", message: "prompt is required" }, { status: 422 });
      }

      const launchableFlows = librarian
        ? await listLaunchableFlowSummaries(ctx.projectId, db)
        : [];
      const requestedFlow = body.flowId
        ? launchableFlows.find((flow) => flow.id === body.flowId || flow.ref === body.flowId)
        : null;

      if (librarian && body.flowId && !requestedFlow) {
        return NextResponse.json({ code: "CONFIG", message: "selected flow is not launchable" }, { status: 422 });
      }

      const flowId = librarian
        ? (requestedFlow?.id ?? (launchableFlows.length === 1 ? launchableFlows[0].id : undefined))
        : body.flowId;
      const turn = librarian && ctx.actor.librarianTurnId
        ? await db.query.librarianTurns.findFirst({
            where: eq(librarianTurns.id, ctx.actor.librarianTurnId),
            columns: { conversationId: true, messageId: true },
          })
        : null;

      if (librarian && (!turn || !ctx.operationId)) {
        return NextResponse.json({ code: "PRECONDITION", message: "librarian turn has no operation" }, { status: 409 });
      }

      const receipt = librarian
        ? {
            revision: 1,
            launchability: flowId ? "requires_admission_check" : "unconfigured",
            nextStep: flowId ? "check_launch_options" : "send_to_triage_or_choose_flow",
          }
        : {};

      try {
        const { taskId } = await (db as TransactionalDb).transaction(
          async (tx) => {
            const created = await createTask(
              {
                title: body.title,
                prompt: body.statement ? renderStatementPrompt(body.statement) : body.prompt!,
                flowId,
              },
              {
                projectId: ctx.projectId,
                actorUserId: actorUserIdForToken(ctx.actor),
                librarianOperationId: ctx.operationId,
                // ADR-156: an agent token cannot be expressed as an
                // actorUserId — without this the emitted `task.created` is
                // `actor_type='system'` and the chain-depth cap never binds.
                actor: socialActorForToken(ctx.actor),
                // Server-derived from the deterministic `agent-run:<runId>`
                // token name, never a request field — and existence-checked, or
                // a token outliving its run row FKs the emit into a 500.
                producedByRunId: await resolveProducingRunId(
                  ctx.actor.boundRunId,
                  tx,
                ),
              },
              tx,
            );

            if (librarian && body.statement && turn) {
              const typedTx = tx as ReturnType<typeof getDb>;

              await typedTx.insert(taskStatementRevisions).values({
                taskId: created.taskId,
                revision: 1,
                statement: { ...body.statement },
                authorActorType: "user",
                authorActorId: ctx.actor.ownerUserId,
                viaOperationId: ctx.operationId,
              });
              await typedTx.insert(librarianTaskLinks).values({
                conversationId: turn.conversationId,
                taskId: created.taskId,
                meaning: "created_from",
                fromMessageId: turn.messageId,
                toMessageId: turn.messageId,
                statementRevision: 1,
              });
              await recordTaskActivity(typedTx, {
                taskId: created.taskId,
                projectId: ctx.projectId,
                actor: socialActorForToken(ctx.actor),
                eventKind: "statement_accepted",
                payload: { statementRevision: 1, viaOperationId: ctx.operationId },
              });
            }

            await recordRequiredTokenAudit(
              {
                ...tokenAuditIdentity(ctx.actor),
                projectId: ctx.projectId,
                scopeUsed: "tasks:create",
                endpoint: ENDPOINT_TASKS,
                method: "POST",
                result: "ok",
                statusCode: 201,
                operationId: ctx.operationId,
                operation: ctx.operationId
                  ? { id: ctx.operationId, result: { statusCode: 201, body: { taskId: created.taskId, ...receipt } } }
                  : undefined,
              },
              tx,
            );

            return created;
          },
        );

        return NextResponse.json({ taskId, ...receipt }, { status: 201 });
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }
        throw err;
      }
    },
  );
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:read",
      admitLibrarian: true,
      endpoint: ENDPOINT_TASKS_GET,
      method: "GET",
      db,
    },
    async (ctx) => {
      const tasks = await listTaskDTOs(ctx.projectId, db);

      return NextResponse.json({ tasks }, { status: 200 });
    },
  );
}
