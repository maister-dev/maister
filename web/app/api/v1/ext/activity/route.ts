import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { parsePulseCursor } from "@/lib/ext-activity/cursor";
import { parseActivitySalience } from "@/lib/ext-activity/salience";
import {
  getActivityPulse,
  serializePulseResponse,
} from "@/lib/ext-activity/service";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/activity";
const log = pino({
  name: "ext-activity-route",
  level: process.env.LOG_LEVEL ?? "info",
});

function extError(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForExtCode(err.code) },
    );
  }

  throw err;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
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
        const since = parsePulseCursor(req.nextUrl.searchParams.get("since"));
        const salience = parseActivitySalience(
          req.nextUrl.searchParams.get("salience"),
        );
        const response = await getActivityPulse(ctx.projectId, {
          since,
          salience,
          client: db,
        });

        log.debug(
          {
            projectId: ctx.projectId,
            since,
            salience,
            happenedCount: response.happened.items.length,
            nowCount: response.now.runs.length,
            // ADR-152 D4: `needsYouCount` stays HITL-only. Folding promotable
            // runs into it would silently change the meaning of an existing
            // telemetry series, so the new blocks get their own counters.
            needsYouCount: response.needsYou.items.length,
            promotableCount: response.needsYou.promotable.length,
          },
          "served ext activity pulse",
        );

        return NextResponse.json(serializePulseResponse(response), {
          status: 200,
        });
      } catch (err) {
        return extError(err);
      }
    },
  );
}
