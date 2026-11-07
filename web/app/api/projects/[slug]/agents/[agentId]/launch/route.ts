import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import { launchAgentRun, loadAgentContext } from "@/lib/agents/launch";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { decodeRouteParam } from "@/lib/route-params";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { acceptInteractiveTaskLaunch } from "@/lib/tasks/launch-intent";
import {
  assertInteractiveLaunchOrigin,
  taskLaunchRequestKey,
  taskLaunchErrorResponse,
} from "@/lib/tasks/launch-http";
import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";

const { projects } = schemaModule as unknown as Record<string, any>;

const bodySchema = z
  .object({
    taskId: z.string().guid().optional(),
    runnerId: z.string().min(1).max(128).optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]).optional(),
    expectedTaskRevision: z.number().int().nonnegative().optional(),
    expectedSettingsToken: z.string().min(1).max(256).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    // Authz-first: authenticate before resolving the slug; project
    // membership is enforced right after the minimal project lookup.
    await requireActiveSession();

    assertInteractiveLaunchOrigin(req);
    const agentId = decodeRouteParam(rawAgentId, "agentId");

    const db = getDb();
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "launchRun");

    let body: z.infer<typeof bodySchema> = {};

    const raw = await req.text();

    if (raw.trim() !== "") {
      const parsed = bodySchema.safeParse(JSON.parse(raw));

      if (!parsed.success) {
        throw new MaisterError(
          "CONFIG",
          `invalid POST body: ${parsed.error.message}`,
        );
      }
      body = parsed.data;
    }

    const input = {
      agentId,
      projectId: project.id,
      taskId: body.taskId ?? null,
      launchOverrideRunnerId: body.runnerId ?? null,
      workspace: body.workspace ?? null,
      trigger: { source: "manual" as const },
    };

    if (body.taskId) {
      const context = await loadAgentContext(db, input);

      if (context.effective.parsed.kind === "code_delivery") {
        const principal = await interactiveTaskLaunchPrincipal();

        if (
          body.expectedTaskRevision === undefined ||
          !body.expectedSettingsToken
        )
          throw new MaisterError(
            "CONFIG",
            "Read the task launch preview before launching this agent",
            { details: { reason: "launch_request_upgrade_required" } },
          );
        const metadata = {
          taskId: body.taskId,
          expectedTaskRevision: body.expectedTaskRevision,
          expectedSettingsToken: body.expectedSettingsToken,
          ...(body.runnerId ? { runnerId: body.runnerId } : {}),
        };
        const receipt = await acceptInteractiveTaskLaunch(
          db,
          principal,
          {
            ...metadata,
            agentId,
            ...(body.workspace ? { workspace: body.workspace } : {}),
          },
          taskLaunchRequestKey(req),
        );

        wakeAcceptedTaskLaunch(db, receipt);

        return NextResponse.json(receipt, {
          status: 202,
          headers: {
            Location: `/api/task-launch-intents/${receipt.intentId}`,
            "Cache-Control": "no-store",
          },
        });
      }
    }
    const result = await launchAgentRun(input);

    if ("deduped" in result) {
      throw new MaisterError("CONFLICT", "agent trigger already claimed");
    }
    if ("queued" in result) {
      wakeAcceptedTaskLaunch(db, result.receipt);

      return NextResponse.json(result.receipt, {
        status: 202,
        headers: {
          Location: `/api/task-launch-intents/${result.receipt.intentId}`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(
      {
        runId: result.runId,
        status: result.status,
        ...(result.queuePosition !== undefined
          ? { queuePosition: result.queuePosition }
          : {}),
        ...(result.queueReason ? { queueReason: result.queueReason } : {}),
      },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof SyntaxError) {
      return agentsErrorResponse(
        new MaisterError("CONFIG", `invalid JSON body: ${err.message}`),
      );
    }

    if (
      err instanceof MaisterError &&
      typeof err.details?.reason === "string" &&
      String(err.details.reason).startsWith("launch_")
    )
      return taskLaunchErrorResponse(err);

    return agentsErrorResponse(err);
  }
}
