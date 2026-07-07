import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { ExperimentNotFoundError } from "@/lib/experiments/errors";
import {
  appendExperimentAdvisory,
  experimentAdvisoryInputSchema,
  isUnauthorizedExperimentAgentActor,
} from "@/lib/experiments/advisory";
import { isMaisterError } from "@/lib/errors";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT =
  "POST /api/v1/ext/projects/[slug]/experiments/[experimentId]/advisory";

const log = pino({
  name: "api-ext-experiment-advisory",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; experimentId: string }>;
};

function bodyErrorResponse(message: string): NextResponse {
  return NextResponse.json(
    {
      code: "CONFIG",
      message,
    },
    { status: 422 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, experimentId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "experiments:advise",
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      if (isUnauthorizedExperimentAgentActor(ctx.actor)) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message:
              "experiment advisory is reserved for the experiment judge agent",
          },
          { status: 403 },
        );
      }

      let body: unknown;

      try {
        body = await req.json();
      } catch (err) {
        if (err instanceof SyntaxError) {
          log.debug(
            { slug, experimentId, message: err.message },
            "[FIX:experiment-advisory-body] rejected malformed JSON body",
          );

          return bodyErrorResponse(`invalid body: ${err.message}`);
        }

        throw err;
      }

      const parsed = experimentAdvisoryInputSchema.safeParse(body);

      if (!parsed.success) {
        return bodyErrorResponse(`invalid body: ${parsed.error.message}`);
      }

      try {
        return NextResponse.json(
          await appendExperimentAdvisory(
            {
              projectId: ctx.projectId,
              experimentId,
              actorLabel: ctx.actor.actorLabel,
              agentRunId: ctx.actor.boundRunId,
              input: parsed.data,
              audit: (tx) =>
                recordRequiredTokenAudit(
                  {
                    tokenId: ctx.actor.tokenId,
                    projectId: ctx.projectId,
                    actorLabel: ctx.actor.actorLabel,
                    scopeUsed: "experiments:advise",
                    endpoint: ENDPOINT,
                    method: "POST",
                    result: "ok",
                    statusCode: 200,
                  },
                  tx,
                ),
            },
            db,
          ),
        );
      } catch (err) {
        if (err instanceof ExperimentNotFoundError) {
          return NextResponse.json(
            { code: "NOT_FOUND", message: err.message },
            { status: 404 },
          );
        }
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
