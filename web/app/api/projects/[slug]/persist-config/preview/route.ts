import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { previewProjectConfiguration } from "@/lib/project-config-persistence/service";
import {
  configErrorResponse,
  configHttpContext,
  configJson,
  configRequestBody,
  emptyConfigBody,
  requireConfigReviewAccess,
} from "@/lib/project-config-persistence/http";

type RouteParams = { params: Promise<{ slug: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const context = await configHttpContext(slug);

    await requireConfigReviewAccess(context);
    await configRequestBody(request, emptyConfigBody);

    return configJson(
      await previewProjectConfiguration(
        context.db,
        context.projectId,
        context.actorUserId,
      ),
    );
  } catch (error) {
    return configErrorResponse(error);
  }
}
