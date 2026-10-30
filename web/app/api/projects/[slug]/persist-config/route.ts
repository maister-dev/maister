import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { currentConfigStatus } from "@/lib/project-config-persistence/status";
import { confirmProjectConfiguration } from "@/lib/project-config-persistence/service";
import {
  settleConfigReceipt,
  latestActorConfigOperation,
} from "@/lib/project-config-persistence/receipts";
import {
  configErrorResponse,
  configHttpContext,
  configJson,
  configOperationIdentity,
  configRequestBody,
  confirmConfigBody,
  requireConfigReviewAccess,
} from "@/lib/project-config-persistence/http";

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  _request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const context = await configHttpContext(slug);
    const status = await currentConfigStatus(context.db, context.projectId);
    const operationId = await latestActorConfigOperation(
      context.db,
      context.projectId,
      context.actorUserId,
    );

    return configJson({ ...status, ...(operationId ? { operationId } : {}) });
  } catch (error) {
    return configErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const context = await configHttpContext(slug);

    await requireConfigReviewAccess(context);
    const body = await configRequestBody(request, confirmConfigBody);
    const operation = await confirmProjectConfiguration(
      context.db,
      configOperationIdentity(context, body.previewId),
      () => requireConfigReviewAccess(context),
    );

    return configJson(
      await settleConfigReceipt(context.db, operation, () =>
        requireConfigReviewAccess(context),
      ),
    );
  } catch (error) {
    return configErrorResponse(error);
  }
}
