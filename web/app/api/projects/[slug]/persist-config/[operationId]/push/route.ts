import "server-only";
import type { NextRequest, NextResponse } from "next/server";

import { confirmConfigurationPush } from "@/lib/project-config-persistence/push";
import {
  confirmPushBody,
  configErrorResponse,
  configHttpContext,
  configJson,
  configOperationIdentity,
  configRequestBody,
  requireConfigReviewAccess,
} from "@/lib/project-config-persistence/http";
type RouteParams = { params: Promise<{ slug: string; operationId: string }> };
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, operationId } = await params;
    const context = await configHttpContext(slug);

    await requireConfigReviewAccess(context);
    const identity = configOperationIdentity(context, operationId);
    const body = await configRequestBody(request, confirmPushBody);

    return configJson(
      await confirmConfigurationPush(
        context.db,
        identity,
        body.pushPreviewId,
        () => requireConfigReviewAccess(context),
      ),
    );
  } catch (error) {
    return configErrorResponse(error);
  }
}
