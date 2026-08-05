import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { createTask } from "@/lib/services/tasks";
import { listTaskDTOs } from "@/lib/services/tasks";
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
    prompt: z.string().min(1),
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
      endpoint: ENDPOINT_TASKS,
      method: "POST",
      successAuditInWork: true,
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

      try {
        const { taskId } = await (db as TransactionalDb).transaction(
          async (tx) => {
            const created = await createTask(
              {
                title: body.title,
                prompt: body.prompt,
                flowId: body.flowId,
              },
              {
                projectId: ctx.projectId,
                actorUserId: actorUserIdForToken(ctx.actor),
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

            await recordRequiredTokenAudit(
              {
                tokenId: ctx.actor.tokenId,
                projectId: ctx.projectId,
                actorLabel: ctx.actor.actorLabel,
                scopeUsed: "tasks:create",
                endpoint: ENDPOINT_TASKS,
                method: "POST",
                result: "ok",
                statusCode: 201,
              },
              tx,
            );

            return created;
          },
        );

        return NextResponse.json({ taskId }, { status: 201 });
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
