import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { decodeRouteParam } from "@/lib/route-params";
import {
  dispatchSpecialistStand,
  observeSpecialistStand,
  verifySpecialistStand,
} from "@/lib/stand-operations/agent-actions";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const actions = {
  observe: observeSpecialistStand,
  dispatch: dispatchSpecialistStand,
  verification: verifySpecialistStand,
} as const;

function isAction(action: string): action is keyof typeof actions {
  return Object.hasOwn(actions, action);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string; action: string }> },
): Promise<NextResponse> {
  const { operationId, action } = await params;
  const endpoint = "POST /api/v1/ext/stand-operations/[operationId]/[action]";

  return handleOwnedExt(
    request,
    { endpoint, scopeLabel: "targets:read", method: "POST" },
    async ({ actor }) => {
      if (!isAction(action))
        throw new MaisterError(
          "PRECONDITION",
          "The requested stand operation action is unavailable",
          {
            details: { reason: "stand_operation_unavailable" },
          },
        );
      const result = await actions[action](
        getDb(),
        actor.tokenId,
        decodeRouteParam(operationId, "operationId"),
      );

      return knowledgeJson(
        result,
        result.effectState === "unknown" ? 202 : 200,
      );
    },
    (error) => knowledgeErrorResponse(error, endpoint),
  );
}
