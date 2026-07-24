import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { listEligiblePinInstalls } from "@/lib/packages/pin";
import { MaisterError } from "@/lib/errors";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

// FIXME(any): dual drizzle-orm peer-dep variants (see catalog.ts).
const { tasks } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-eval-pin-options",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

// GET — the recipe packagePin picker feed (ADR-150; ported from the retiring
// experiments pin-options). `launchEvaluationRuns`-gated. `taskId` is a query
// param validated against the slug-derived project (a task outside the project
// is a CONFIG refusal — the picker never leaks another project's installs).
export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "launchEvaluationRuns");

    const taskId = req.nextUrl.searchParams.get("taskId")?.trim();

    if (!taskId) {
      throw new MaisterError("CONFIG", "taskId query parameter is required");
    }

    // FIXME(any): dual drizzle dialect union (see catalog.ts).
    const db = getDb() as any;
    const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const task = taskRows[0] as Record<string, unknown> | undefined;

    if (!task || task.projectId !== project.id) {
      throw new MaisterError("CONFIG", `task not found for project: ${taskId}`);
    }

    const options = await listEligiblePinInstalls({ db, taskId });

    return NextResponse.json({ options });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
