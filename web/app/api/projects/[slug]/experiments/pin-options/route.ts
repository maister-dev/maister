import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { errorResponse, resolveProject } from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { listEligiblePinInstalls } from "@/lib/experiments/package-pin";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tasks } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-experiment-pin-options",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

// ADR-132 §b: the variant-editor package-pin picker feed. Read-only,
// `readExperiments`-gated. `taskId` is a query param validated against the
// slug-derived project (a task outside the project is a CONFIG refusal — the
// picker never leaks another project's installs through a forged id).
export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readExperiments");

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
    return errorResponse(err, log, slug);
  }
}
