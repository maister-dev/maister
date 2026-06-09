import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { remoteNameSchema } from "@/lib/worktree";
import { exportWorkbenchBranch } from "@/lib/workbench-lifecycle/service";

const exportBodySchema = z
  .object({
    remote: remoteNameSchema.default("origin"),
    snapshotDirty: z.boolean().default(false),
    commitMessage: z
      .string()
      .min(1)
      .max(4096)
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    force: z.boolean().default(false),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const parsed = parseRouteBody(exportBodySchema, await parseJsonBody(req));
    const body = {
      remote: parsed.remote ?? "origin",
      snapshotDirty: parsed.snapshotDirty ?? false,
      commitMessage: parsed.commitMessage ?? null,
      force: parsed.force ?? false,
    };

    return NextResponse.json(await exportWorkbenchBranch(runId, body));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/export-branch",
    });
  }
}
