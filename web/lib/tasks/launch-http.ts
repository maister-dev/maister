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
import { nodeEnforcementRefusalSchema } from "@/lib/flows/enforcement-refusal";

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
  flow_settings_enforcement_refused:
    "The selected runner cannot enforce a required Flow setting. Adjust the indicated node or choose a compatible runner, then refresh launch options.",
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

function refuseInteractiveOrigin(): never {
  throw new MaisterError(
    "UNAUTHORIZED",
    "An interactive launch must use the same origin",
    { details: { reason: "launch_interactive_origin_required" } },
  );
}

/** Host is transport authority; Next's internal bind hostname is not the public origin. */
function requestHostOrigin(request: Request): string {
  const protocol = new URL(request.url).protocol;
  const host = request.headers.get("host");

  if (protocol !== "http:" && protocol !== "https:")
    return refuseInteractiveOrigin();
  if (host === null) return new URL(request.url).origin;
  if (!host || host.length > 1024 || /[\s\\/?#@,]/u.test(host))
    return refuseInteractiveOrigin();
  let authority: URL;

  try {
    authority = new URL(`${protocol}//${host}`);
  } catch {
    return refuseInteractiveOrigin();
  }
  if (!authority.hostname || authority.username || authority.password)
    return refuseInteractiveOrigin();

  return authority.origin;
}

function configuredInteractiveOrigin(): string | null {
  const configured = process.env.AUTH_URL;

  // Auth.js treats an empty optional URL as unset and supports an auth base path.
  if (configured === undefined || configured === "") return null;
  if (configured.trim() !== configured || /[\r\n\t]/u.test(configured))
    throw invalidOriginConfiguration();
  let authority: URL;

  try {
    authority = new URL(configured);
  } catch {
    throw invalidOriginConfiguration();
  }
  if (
    !["http:", "https:"].includes(authority.protocol) ||
    !authority.hostname ||
    authority.username ||
    authority.password ||
    authority.href.includes("?") ||
    authority.href.includes("#")
  )
    throw invalidOriginConfiguration();

  return authority.origin;
}

function invalidOriginConfiguration(): MaisterError {
  // Never attach the parser error or URL: configuration can contain secrets.
  return new MaisterError(
    "CONFIG",
    "AUTH_URL must be an absolute HTTP(S) URL without credentials, query or fragment",
    { details: { reason: "launch_origin_configuration_invalid" } },
  );
}

/** A session cookie authenticates the user; same-origin protection authenticates the interactive request boundary. */
export function assertInteractiveLaunchOrigin(request: Request): void {
  // Validate any present Host even when configured public authority takes precedence.
  const transportOrigin = requestHostOrigin(request);
  const canonicalOrigin = configuredInteractiveOrigin() ?? transportOrigin;

  if (
    request.headers.get("origin") !== canonicalOrigin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    refuseInteractiveOrigin();
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
    const originalReason = manifest
      ? `flow_${manifest.kind}`
      : typeof error.details?.reason === "string"
        ? error.details.reason
        : "launch_technical_precondition";
    const enforcement =
      originalReason === "flow_settings_enforcement_refused"
        ? nodeEnforcementRefusalSchema.safeParse({
            reason: originalReason,
            nodeId: error.details?.nodeId,
            capabilityClass: error.details?.capabilityClass,
            capabilityAgent: error.details?.capabilityAgent,
            declared: error.details?.declared,
            capability: error.details?.capability,
          })
        : null;
    const invalidEnforcement = enforcement !== null && !enforcement.success;
    const reason = invalidEnforcement
      ? "launch_technical_precondition"
      : originalReason;
    const code = invalidEnforcement ? "CONFIG" : error.code;
    const status =
      reason === "launch_not_found" ? 404 : httpStatusForCode(code);
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

    log.warn(
      {
        code,
        reason,
        status,
        ...(enforcement?.success ? enforcement.data : {}),
      },
      "task-launch-http-refused",
    );

    return NextResponse.json(
      {
        code,
        message: Object.hasOwn(PUBLIC_LAUNCH_MESSAGES, reason)
          ? PUBLIC_LAUNCH_MESSAGES[reason]
          : "Task launch request could not be accepted",
        details: {
          reason,
          ...(conflict?.success ? { existing: conflict.data } : {}),
          ...(runnerSlot?.success ? runnerSlot.data : {}),
          ...(enforcement?.success ? enforcement.data : {}),
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
