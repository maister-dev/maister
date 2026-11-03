import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { wakeAcceptedTaskLaunch } from "@/lib/tasks/launch-wake";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptConcurrentInteractiveTaskLaunch,
  acceptInteractiveTaskLaunch,
} from "@/lib/tasks/launch-intent";
import {
  assertInteractiveLaunchOrigin,
  readTaskLaunchBody,
  taskLaunchErrorResponse,
  taskLaunchRequestKey,
} from "@/lib/tasks/launch-http";
import {
  taskLaunchBodySchema,
  taskLaunchFieldsSchema,
  validateTaskLaunchTarget,
} from "@/lib/tasks/launch-schema";
import { MaisterError } from "@/lib/errors";

// Preserve legacy field recognition while refusing operations that require a
// separate setup decision. None of these fields can grant admission authority.
const compatibilityBodySchema = taskLaunchFieldsSchema
  .partial({ expectedTaskRevision: true, expectedSettingsToken: true })
  .extend({
    allowConcurrent: z.boolean().optional(),
    relaunchOfRunId: z.string().min(1).max(256).optional(),
    packageVersions: z
      .record(
        z.string().min(1).max(256),
        z.enum(["keep", "try_once", "adopt", "cut_and_adopt"]),
      )
      .refine((choices) => Object.keys(choices).length <= 64)
      .optional(),
  })
  .strict()
  .superRefine(validateTaskLaunchTarget);

type CompatibilityReason =
  "launch_request_upgrade_required" | "launch_request_setup_required";

function compatibilityDecisionRequired(
  taskId: string,
  reason: CompatibilityReason,
): NextResponse {
  return NextResponse.json(
    {
      code: "CONFIG",
      message:
        reason === "launch_request_upgrade_required"
          ? "Refresh launch options, then submit the displayed revision and settings token with a stable Idempotency-Key. Preserve that exact request when retrying."
          : "Complete package setup through /api/projects/{slug}/flow-packages/{flowRefId}/upgrade or /api/studio/local-packages/{id}/cut-version, then refresh launch options. For legacy lineage, choose a new explicit launch in the task launcher. This request did not authorize a launch.",
      details: {
        reason,
        optionsEndpoint: `/api/runs/launch-options?taskId=${encodeURIComponent(taskId)}`,
        intentEndpoint: "/api/task-launch-intents",
      },
    },
    { status: 422, headers: { "Cache-Control": "no-store" } },
  );
}

/** The compatibility route accepts the same one-shot decision as the intent API. Acceptance never implies model start. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const principal = await interactiveTaskLaunchPrincipal();

    assertInteractiveLaunchOrigin(request);
    const parsed = compatibilityBodySchema.safeParse(
      await readTaskLaunchBody(request),
    );

    if (!parsed.success)
      throw new MaisterError("CONFIG", "Task launch body is invalid", {
        details: { reason: "launch_request_invalid" },
      });
    const body = parsed.data;

    if (
      body.expectedTaskRevision === undefined ||
      body.expectedSettingsToken === undefined ||
      !request.headers.get("idempotency-key")
    )
      return compatibilityDecisionRequired(
        body.taskId,
        "launch_request_upgrade_required",
      );
    const requestKey = taskLaunchRequestKey(request);

    if (
      Object.values(body.packageVersions ?? {}).some(
        (choice) => choice === "adopt" || choice === "cut_and_adopt",
      )
    )
      return compatibilityDecisionRequired(
        body.taskId,
        "launch_request_setup_required",
      );
    const { allowConcurrent, ...selection } = body;
    const canonical = taskLaunchBodySchema.parse(selection);
    const db = getDb();
    const receipt = allowConcurrent
      ? await acceptConcurrentInteractiveTaskLaunch(
          db,
          principal,
          canonical,
          requestKey,
        )
      : await acceptInteractiveTaskLaunch(db, principal, canonical, requestKey);
    const location = `/api/task-launch-intents/${receipt.intentId}`;

    wakeAcceptedTaskLaunch(db, receipt);
    const headers = { Location: location, "Cache-Control": "no-store" };

    if (receipt.runId) {
      const [run] = await db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(eq(runs.id, receipt.runId));

      if (run?.status === "Pending" || run?.status === "Running")
        return NextResponse.json(
          { runId: run.id, status: run.status },
          { status: 202, headers },
        );
    }

    return NextResponse.json(
      {
        accepted: true,
        code: "launch_pending",
        intentId: receipt.intentId,
        location,
      },
      { status: 202, headers },
    );
  } catch (error) {
    return taskLaunchErrorResponse(error);
  }
}
