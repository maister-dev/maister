import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  appendExperimentAdvisory,
  experimentAdvisoryInputSchema,
} from "@/lib/experiments/advisory";
import { isMaisterError } from "@/lib/errors";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT =
  "POST /api/v1/ext/projects/[slug]/experiments/[experimentId]/advisory";

type RouteParams = {
  params: Promise<{ slug: string; experimentId: string }>;
};

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
      const parsed = experimentAdvisoryInputSchema.safeParse(await req.json());

      if (!parsed.success) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${parsed.error.message}`,
          },
          { status: 422 },
        );
      }

      try {
        return NextResponse.json(
          await appendExperimentAdvisory(
            {
              projectId: ctx.projectId,
              experimentId,
              actorLabel: ctx.actor.actorLabel,
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
