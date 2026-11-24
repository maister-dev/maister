import "server-only";

import type { ProjectHostSettings } from "@/lib/execution-host/project-preference";

import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { errorResponse, resolveProject } from "@/lib/api/project-route-helpers";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  projectHostSettingsEtag,
  readProjectHostSettings,
  updateProjectHostSettings,
} from "@/lib/execution-host/project-preference";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import {
  assertInteractiveLaunchOrigin,
  readInteractiveLaunchPreview,
} from "@/lib/tasks/launch-http";

type RouteParams = { params: Promise<{ slug: string }> };
const hostPreference = z
  .object({
    defaultExecutionHostId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
      .nullable(),
  })
  .strict();
const log = pino({
  name: "api-project-execution-host",
  level: process.env.LOG_LEVEL ?? "info",
});

function response(settings: ProjectHostSettings): NextResponse {
  return NextResponse.json(settings, {
    headers: {
      etag: projectHostSettingsEtag(settings),
      "cache-control": "private, no-store",
    },
  });
}

function preferenceError(error: unknown, slug: string): NextResponse {
  if (
    isMaisterError(error) &&
    error.code === "UNAUTHORIZED" &&
    error.details?.reason === "launch_authority_revoked"
  )
    return errorResponse(
      new MaisterError(
        "UNAUTHORIZED",
        "Project administrator access is required",
        {
          details: { reason: "insufficient_project_role" },
        },
      ),
      log,
      slug,
    );

  return errorResponse(error, log, slug);
}

export async function GET(
  _request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  try {
    const actor = await requireActiveSession();
    const { id } = await resolveProject(slug);

    return response(await readProjectHostSettings(getDb(), id, actor.id));
  } catch (error) {
    return preferenceError(error, slug);
  }
}

export async function PATCH(
  request: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  try {
    const actor = await requireActiveSession();
    const { id } = await resolveProject(slug);
    const db = getDb();
    await assertTaskLaunchUserAuthority(db, id, actor.id, ["editSettings"]);
    assertInteractiveLaunchOrigin(request);
    const parsed = hostPreference.safeParse(
      await readInteractiveLaunchPreview(request),
    );
    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "The project preference must specify a host ID or null",
        {
          details: { reason: "invalid_request" },
        },
      );

    return response(
      await updateProjectHostSettings(db, {
        projectId: id,
        userId: actor.id,
        ifMatch: request.headers.get("if-match"),
        defaultExecutionHostId: parsed.data.defaultExecutionHostId,
      }),
    );
  } catch (error) {
    return preferenceError(error, slug);
  }
}
