import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import {
  getProjectAutomationDetail,
  type AutomationKind,
} from "@/lib/scheduled-launches/queries";

const log = pino({
  name: "api-project-automation-detail",
  level: process.env.LOG_LEVEL ?? "info",
});

const kindSchema = z.enum([
  "one_time_task_launch",
  "recurring_task_schedule",
  "agent_cron",
  "agent_event",
]);

type RouteParams = {
  params: Promise<{ slug: string; kind: string; automationId: string }>;
};

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, kind, automationId } = await params;

  try {
    await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readBoard");
    const parsedKind = kindSchema.safeParse(kind);

    if (!parsedKind.success) {
      throw new MaisterError("CONFIG", "automation kind is invalid");
    }
    const automation = await getProjectAutomationDetail({
      projectId: project.id,
      projectSlug: slug,
      kind: parsedKind.data as AutomationKind,
      automationId,
    });

    if (!automation) return notFoundResponse("automation not found");

    return NextResponse.json({ automation });
  } catch (error) {
    return errorResponse(error, log, slug);
  }
}
