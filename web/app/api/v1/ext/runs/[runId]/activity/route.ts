import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import {
  parseRunActivityLimit,
  parseRunSinceId,
} from "@/lib/ext-activity/cursor";
import { parseActivitySalience } from "@/lib/ext-activity/salience";
import {
  getRunActivityResponse,
  serializeRunActivityResponse,
} from "@/lib/ext-activity/service";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/runs/[runId]/activity";
const log = pino({
  name: "ext-run-activity-route",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

function extError(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForExtCode(err.code) },
    );
  }

  throw err;
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "runs:read",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      try {
        const sinceId = parseRunSinceId(
          req.nextUrl.searchParams.get("sinceId"),
        );
        const limit = parseRunActivityLimit(
          req.nextUrl.searchParams.get("limit"),
        );
        const salience = parseActivitySalience(
          req.nextUrl.searchParams.get("salience"),
        );
        const response = await getRunActivityResponse(ctx.projectId, runId, {
          sinceId,
          limit,
          salience,
          client: db,
        });

        if (!response) {
          return NextResponse.json(
            { code: "NOT_FOUND", message: "run not found" },
            { status: 404 },
          );
        }

        log.debug(
          {
            projectId: ctx.projectId,
            runId,
            sinceId,
            limit,
            salience,
            itemCount: response.items.length,
            hasMore: response.hasMore,
          },
          "served ext run activity",
        );

        return NextResponse.json(serializeRunActivityResponse(response), {
          status: 200,
        });
      } catch (err) {
        return extError(err);
      }
    },
  );
}
