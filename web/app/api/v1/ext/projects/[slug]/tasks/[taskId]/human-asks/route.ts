import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { validateFormSchemaVersion } from "@/lib/config";
import { formSchemaSchema } from "@/lib/config.schema";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { createOrActivateAgentQuestion } from "@/lib/services/agent-question";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const ENDPOINT = "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/human-asks";
const SCOPE = "hitl:request";

const bodySchema = z
  .object({
    question: z.string().min(1).max(10_000),
    schema: formSchemaSchema,
    reTriggerMode: z.enum(["agent", "triage"]).default("agent"),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      if (
        ctx.actor.tokenKind !== "agent" ||
        ctx.actor.agentId === null ||
        ctx.actor.boundRunId === null
      ) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      let body: z.infer<typeof bodySchema>;

      try {
        body = bodySchema.parse(await req.json());
        validateFormSchemaVersion(body.schema, 1);
      } catch (error) {
        return NextResponse.json(
          { code: "CONFIG", message: "invalid human ask body" },
          { status: 422 },
        );
      }

      const sourceRows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, ctx.actor.boundRunId),
            eq(runs.projectId, ctx.projectId),
            eq(runs.taskId, taskId),
            eq(runs.agentId, ctx.actor.agentId),
            eq(runs.runKind, "agent"),
            eq(runs.status, "Running"),
          ),
        );

      if (!sourceRows[0]) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      try {
        const result = await createOrActivateAgentQuestion(
          {
            projectId: ctx.projectId,
            taskId,
            sourceRunId: ctx.actor.boundRunId,
            sourceAgentId: ctx.actor.agentId,
            question: body.question,
            schema: body.schema,
            reTriggerMode: body.reTriggerMode,
          },
          {
            db,
            recordSuccessAudit: (tx, statusCode) =>
              recordRequiredTokenAudit(
                {
                  tokenId: ctx.actor.tokenId,
                  projectId: ctx.projectId,
                  actorLabel: ctx.actor.actorLabel,
                  scopeUsed: SCOPE,
                  endpoint: ENDPOINT,
                  method: "POST",
                  result: "ok",
                  statusCode,
                },
                tx,
              ),
          },
        );
        const status =
          result.activationState === "active"
            ? result.created
              ? 201
              : 200
            : 202;

        return NextResponse.json(
          {
            hitlRequestId: result.hitlRequestId,
            taskId: result.taskId,
            sourceRunId: result.sourceRunId,
            activationState: result.activationState,
          },
          { status },
        );
      } catch (error) {
        if (!isMaisterError(error)) throw error;

        const status =
          error.code === "UNAUTHORIZED"
            ? 403
            : httpStatusForExtCode(error.code);

        return NextResponse.json(
          { code: error.code, message: error.message },
          { status },
        );
      }
    },
  );
}
