import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { isMaisterError } from "@/lib/errors";
import { httpStatusForCode } from "@/lib/api/project-route-helpers";
import {
  integrityPatchSchema,
  workspaceIntegrityFieldNames,
  type IntegrityField,
} from "@/lib/workspace-integrity/settings-schema";
import {
  readIntegritySettings,
  updateIntegritySettings,
} from "@/lib/workspace-integrity/settings";

const log = pino({
  name: "workspace-integrity.http",
  level: process.env.LOG_LEVEL ?? "info",
});

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function failure(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const { reason, field } = error.details ?? {};
    return json(
      {
        code: error.code,
        message: error.message,
        ...(reason ? { details: { reason, ...(field ? { field } : {}) } } : {}),
      },
      error.code === "CONFIG" ? 422 : httpStatusForCode(error.code),
    );
  }
  const { sqlState } = queryErrorDiagnostics(error);
  log.error({ sqlState }, "workspace integrity settings request failed");
  if (
    sqlState &&
    (sqlState.startsWith("08") ||
      ["53300", "57014", "57P01", "57P02", "57P03"].includes(sqlState))
  )
    return json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message: "Platform settings storage is temporarily unavailable",
      },
      503,
    );

  return json({ code: "CRASH", message: "Internal error" }, 500);
}

function invalid(field?: IntegrityField): NextResponse {
  return json(
    {
      code: "CONFIG",
      message: "Invalid workspace integrity settings",
      details: field
        ? { reason: "invalid_value", field }
        : { reason: "invalid_body" },
    },
    422,
  );
}

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    return json(await readIntegritySettings(getDb()));
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("admin");
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return invalid();

    const result = integrityPatchSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!result.success) {
      if (
        result.error.issues.some((issue) => issue.code === "unrecognized_keys")
      )
        return invalid();
      const field = workspaceIntegrityFieldNames.find((name) =>
        result.error.issues.some((issue) => issue.path[0] === name),
      );
      return invalid(field);
    }

    return json(await updateIntegritySettings(getDb(), result.data, user.id));
  } catch (error) {
    return failure(error);
  }
}
