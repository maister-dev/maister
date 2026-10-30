import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { configOperation } from "@/lib/project-config-persistence/service";
import { configReceipt } from "@/lib/project-config-persistence/receipts";
import {
  configErrorResponse,
  configHttpContext,
  configJson,
  configOperationIdentity,
  requireConfigReviewAccess,
} from "@/lib/project-config-persistence/http";

type RouteParams = { params: Promise<{ slug: string; operationId: string }> };

export async function GET(
  _request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, operationId } = await params;
    const context = await configHttpContext(slug);

    await requireConfigReviewAccess(context);
    const operation = await configOperation(
      context.db,
      configOperationIdentity(context, operationId),
    );

    return configJson(await configReceipt(context.db, operation));
  } catch (error) {
    return configErrorResponse(error);
  }
}
