import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { taskLaunchConflictReferenceSchema } from "./launch-conflict";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { httpStatusForCode } from "@/lib/api/project-route-helpers";
import { getFlowManifestIncompatibility } from "@/lib/flows/manifest-parser";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";

const log = pino({
  name: "task-launch-http",
  level: process.env.LOG_LEVEL ?? "info",
});

const PUBLIC_LAUNCH_MESSAGES: Readonly<Record<string, string>> = {
  launch_request_upgrade_required:
    "Read launch options, then send expectedTaskRevision, expectedSettingsToken and Idempotency-Key. MCP callers can use task_launch_options followed by task_launch.",
  launch_request_key_required:
    "Send a stable Idempotency-Key and reuse the same key and payload when retrying an uncertain response.",
  launch_request_setup_required:
    "Complete the selected setup or use the source run's supported retry action, then refresh launch options.",
  flow_runner_unresolved:
    "Assign an available runner to the indicated Flow slot, then refresh launch options.",
  flow_legacy_steps: LEGACY_STEPS_REFUSAL_MESSAGE,
  flow_invalid_manifest:
    "The selected Flow manifest is invalid. Repair or republish its package before launching.",
  flow_engine_incompatible:
    "The selected Flow requires a different MAIster engine. Choose a compatible revision.",
};

const runnerSlotSchema = z
  .object({
    slotKey: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n\u0000-\u001f\u007f]+$/),
    label: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\r\n\u0000-\u001f\u007f]+$/),
  })
  .strict();

/** A session cookie authenticates the user; same-origin protection authenticates the interactive request boundary. */
export function assertInteractiveLaunchOrigin(request: Request): void {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "An interactive launch must use the same origin",
      {
        details: { reason: "launch_interactive_origin_required" },
      },
    );
}

export async function readTaskLaunchBody(request: Request): Promise<unknown> {
  const text = await request.text();

  if (Buffer.byteLength(text, "utf8") > 65_536)
    throw new MaisterError("CONFIG", "Task launch body exceeds 64 KiB", {
      details: { reason: "launch_input_limit" },
    });
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new MaisterError("CONFIG", "Task launch body must be JSON", {
        details: { reason: "launch_request_invalid" },
      });
    throw error;
  }
}

export function taskLaunchRequestKey(request: Request): string {
  const key = request.headers.get("idempotency-key");

  if (!key || key.length > 256)
    throw new MaisterError("CONFIG", "A stable Idempotency-Key is required", {
      details: { reason: "launch_request_key_required" },
    });

  return key;
}

/** Query wrappers and nested Git causes never cross the public error boundary. */
export function taskLaunchErrorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const manifest = getFlowManifestIncompatibility(error);
    const reason = manifest
      ? `flow_${manifest.kind}`
      : typeof error.details?.reason === "string"
        ? error.details.reason
        : "launch_technical_precondition";
    const status =
      reason === "launch_not_found" ? 404 : httpStatusForCode(error.code);
    const conflict =
      reason === "launch_already_reserved"
        ? taskLaunchConflictReferenceSchema.safeParse(error.details?.existing)
        : null;

    const runnerSlot =
      reason === "flow_runner_unresolved"
        ? runnerSlotSchema.safeParse({
            slotKey: error.details?.slotKey,
            label: error.details?.label,
          })
        : null;

    log.warn({ code: error.code, reason, status }, "task-launch-http-refused");

    return NextResponse.json(
      {
        code: error.code,
        message: Object.hasOwn(PUBLIC_LAUNCH_MESSAGES, reason)
          ? PUBLIC_LAUNCH_MESSAGES[reason]
          : "Task launch request could not be accepted",
        details: {
          reason,
          ...(conflict?.success ? { existing: conflict.data } : {}),
          ...(runnerSlot?.success ? runnerSlot.data : {}),
        },
      },
      { status },
    );
  }
  log.error(queryErrorDiagnostics(error), "task-launch-http-failed");

  return NextResponse.json(
    { code: "CRASH", message: "Task launch request could not be processed" },
    { status: 500 },
  );
}
