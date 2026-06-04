import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

const { flowRunnerRemaps, flows, platformAcpRunners, projects } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-flow-runner-remaps",
  level: process.env.LOG_LEVEL ?? "info",
});

const patchBodySchema = z
  .object({
    remapId: z.string().min(1),
    mappedRunnerId: z.string().min(1).nullable(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "project Flow runner remap API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadProject(
  db: any,
  slug: string,
): Promise<Record<string, any>> {
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

async function assertEnabledRunner(
  db: any,
  runnerId: string | null,
): Promise<void> {
  if (runnerId === null) return;

  const runnerRows = await db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, runnerId));
  const runner = runnerRows[0];

  if (!runner) {
    throw new MaisterError("PRECONDITION", `ACP runner not found: ${runnerId}`);
  }
  if (runner.enabled === false) {
    throw new MaisterError(
      "PRECONDITION",
      `ACP runner is disabled: ${runnerId}`,
    );
  }
  if (runner.readinessStatus !== "Ready") {
    throw new MaisterError(
      "PRECONDITION",
      `ACP runner is not ready: ${runnerId}`,
    );
  }
}

function remapView(args: {
  remap: Record<string, any>;
  flowByRevisionId: ReadonlyMap<string, Record<string, any>>;
}): Record<string, unknown> {
  const flow = args.flowByRevisionId.get(args.remap.flowRevisionId);

  return {
    id: args.remap.id,
    flowId: flow?.id ?? null,
    flowRef: flow?.flowRefId ?? args.remap.flowRevisionId,
    flowRevisionId: args.remap.flowRevisionId,
    stepId: args.remap.stepId,
    sourceRunnerId: args.remap.sourceRunnerId,
    mappedRunnerId: args.remap.mappedRunnerId,
    status: args.remap.status,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const project = await loadProject(db, slug);

    await requireProjectAction(project.id, "editSettings");

    const [flowRows, remapRows] = await Promise.all([
      db
        .select({
          id: flows.id,
          flowRefId: flows.flowRefId,
          enabledRevisionId: flows.enabledRevisionId,
        })
        .from(flows)
        .where(eq(flows.projectId, project.id)),
      db
        .select()
        .from(flowRunnerRemaps)
        .where(eq(flowRunnerRemaps.projectId, project.id)),
    ]);
    const flowByRevisionId = new Map<string, Record<string, any>>(
      flowRows
        .filter((flow: Record<string, any>) => flow.enabledRevisionId)
        .map((flow: Record<string, any>) => [
          flow.enabledRevisionId as string,
          flow,
        ]),
    );

    return NextResponse.json({
      remaps: remapRows.map((remap: Record<string, any>) =>
        remapView({ remap, flowByRevisionId }),
      ),
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  let body: z.infer<typeof patchBodySchema>;

  try {
    body = patchBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${err instanceof Error ? err.message : String(err)}`,
      ),
      slug,
    );
  }

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const project = await loadProject(db, slug);

    await requireProjectAction(project.id, "editSettings");
    await assertEnabledRunner(db, body.mappedRunnerId);

    const remapRows = await db
      .select()
      .from(flowRunnerRemaps)
      .where(
        and(
          eq(flowRunnerRemaps.projectId, project.id),
          eq(flowRunnerRemaps.id, body.remapId),
        ),
      );
    const remap = remapRows[0];

    if (!remap) {
      throw new MaisterError(
        "PRECONDITION",
        `Flow runner remap not found: ${body.remapId}`,
      );
    }

    const status = body.mappedRunnerId ? "Mapped" : "Pending";

    await db
      .update(flowRunnerRemaps)
      .set({
        mappedRunnerId: body.mappedRunnerId,
        status,
        updatedAt: new Date(),
      })
      .where(eq(flowRunnerRemaps.id, body.remapId));

    log.info(
      {
        projectId: project.id,
        remapId: body.remapId,
        flowRevisionId: remap.flowRevisionId,
        stepId: remap.stepId,
        sourceRunnerId: remap.sourceRunnerId,
        mappedRunnerId: body.mappedRunnerId,
      },
      "Flow ACP runner remap saved",
    );

    return NextResponse.json({
      ok: true,
      id: body.remapId,
      mappedRunnerId: body.mappedRunnerId,
      status,
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
