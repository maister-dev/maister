import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { branchNameSchema, remoteNameSchema } from "@/lib/worktree";
import {
  exportWorkbenchBranch,
  type ExportWorkbenchBranchInput,
} from "@/lib/workbench-lifecycle/service";

const exportBodySchema = z
  .object({
    remote: remoteNameSchema.default("origin"),
    // ADR-181 D4: the public name; refused once an upstream fixes it.
    branchName: branchNameSchema
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    snapshotDirty: z.boolean().default(false),
    commitMessage: z
      .string()
      .min(1)
      .max(4096)
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    force: z.boolean().default(false),
    // ADR-181 D4: the remote head a force replaces — the `remoteHead` of the
    // refusal the operator confirmed. Exactly with `force`, a full SHA.
    expectedHead: z
      .string()
      .regex(
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
        "expectedHead must be a full SHA",
      )
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.force !== (body.expectedHead !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedHead"],
        message: body.force
          ? "a forced publish needs expectedHead — the remote head it replaces"
          : "expectedHead applies only to a forced publish",
      });
    }
  });

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const parsed = parseRouteBody(exportBodySchema, await parseJsonBody(req));
    const common = {
      remote: parsed.remote ?? "origin",
      branchName: parsed.branchName ?? null,
      snapshotDirty: parsed.snapshotDirty ?? false,
      commitMessage: parsed.commitMessage ?? null,
    };
    const body: ExportWorkbenchBranchInput =
      parsed.force && parsed.expectedHead !== undefined
        ? { ...common, force: true, expectedHead: parsed.expectedHead }
        : { ...common, force: false };

    return NextResponse.json(await exportWorkbenchBranch(runId, body));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/export-branch",
    });
  }
}
