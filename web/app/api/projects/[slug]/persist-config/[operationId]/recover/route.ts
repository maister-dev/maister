import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import {
  configOperation,
  confirmProjectConfiguration,
} from "@/lib/project-config-persistence/service";
import { settleConfigReceipt } from "@/lib/project-config-persistence/receipts";
import {
  configErrorResponse,
  configHttpContext,
  configJson,
  configOperationIdentity,
  configRequestBody,
  emptyConfigBody,
  requireConfigReviewAccess,
} from "@/lib/project-config-persistence/http";
import { recoverConfigurationPushes } from "@/lib/project-config-persistence/push";
import { MaisterError } from "@/lib/errors";

type RouteParams = { params: Promise<{ slug: string; operationId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, operationId } = await params;
    const context = await configHttpContext(slug);

    await requireConfigReviewAccess(context);
    await configRequestBody(request, emptyConfigBody);
    const identity = configOperationIdentity(context, operationId);
    const stored = await configOperation(context.db, identity);

    if (!stored.acceptedAt)
      throw new MaisterError(
        "CONFLICT",
        "This review was never confirmed. Create and confirm a fresh preview.",
        { details: { reason: "stale_preview" } },
      );
    const operation = await confirmProjectConfiguration(
      context.db,
      identity,
      () => requireConfigReviewAccess(context),
    );

    await recoverConfigurationPushes(context.db, identity, () =>
      requireConfigReviewAccess(context),
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
