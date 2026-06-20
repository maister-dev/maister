import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireSession } from "@/lib/authz";
import { forkElementToDefault } from "@/lib/local-packages/fork";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

const log = pino({
  name: "api/studio/packages/[ref]/fork-element",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ ref: string }> };

const bodySchema = z
  .object({
    projectId: z.string().min(1),
    elementPath: z.string().min(1),
  })
  .strict();

// `ref` (url-param) resolves server-side. `projectId` is BODY-controlled, so it
// MUST be validated against the caller's accessible projects (getAccessibleProjects)
// — an inaccessible/unknown project is a 404 with NO write. `elementPath` is
// confined inside the source bundle + destination working dir by the service.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireSession();
    const { ref } = await params;
    const parsed = bodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "CONFIG",
          message: parsed.error.issues[0]?.message ?? "bad body",
        },
        { status: 422 },
      );
    }

    const resolution = await resolveStudioPackageByRef(user.id, user.role, ref);

    if (resolution.status === "not-found") {
      return notFoundResponse("package not found");
    }
    if (resolution.status === "ambiguous" || !resolution.installId) {
      return notFoundResponse("package ref is ambiguous");
    }

    const accessible = await getAccessibleProjects(user.id, user.role);
    const project = accessible.find((p) => p.id === parsed.data.projectId);

    if (!project) {
      return notFoundResponse("project not found");
    }

    const result = await forkElementToDefault({
      projectId: project.id,
      projectName: project.name,
      sourceInstallId: resolution.installId,
      elementPath: parsed.data.elementPath,
      createdBy: user.id,
    });

    log.info(
      {
        ref,
        projectId: project.id,
        elementPath: parsed.data.elementPath,
        localPackageId: result.localPackageId,
      },
      "element forked to default local package",
    );

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err, log, "studio/packages/[ref]/fork-element POST");
  }
}
