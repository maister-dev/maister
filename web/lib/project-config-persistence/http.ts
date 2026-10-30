import "server-only";

import type { PersistenceDb } from "./store";
import type { ConfigOperationIdentity } from "./store";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { CONFIG_PERSIST_REASONS } from "./contracts";

import {
  requireActiveSession,
  requireProjectAction,
  requireProjectActionForUser,
} from "@/lib/authz";
import { pgErrorOf } from "@/lib/db/pg-error";
import { getDb } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "api/project-config-persistence",
  level: process.env.LOG_LEVEL ?? "info",
});

export const emptyConfigBody = z.object({}).strict();
export const confirmConfigBody = z
  .object({ previewId: z.string().uuid() })
  .strict();
export const confirmPushBody = z
  .object({ pushPreviewId: z.string().uuid() })
  .strict();

export type ConfigHttpContext = {
  db: PersistenceDb;
  projectId: string;
  actorUserId: string;
};

export function configJson(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function configHttpContext(
  slug: string,
): Promise<ConfigHttpContext> {
  const actor = await requireActiveSession();
  const db = getDb();
  const [project] = await db
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.slug, slug));

  if (!project || project.archivedAt)
    throw new MaisterError("PRECONDITION", "Project was not found.", {
      details: { httpStatus: 404 },
    });
  await requireProjectAction(project.id, "readBoard");

  return { db, projectId: project.id, actorUserId: actor.id };
}

export async function requireConfigReviewAccess(
  context: ConfigHttpContext,
): Promise<void> {
  await requireProjectActionForUser(
    context.actorUserId,
    context.projectId,
    "editSettings",
  );
  await requireProjectActionForUser(
    context.actorUserId,
    context.projectId,
    "readRepoFiles",
  );
}

/** Read at most the contract's 4 KiB; untrusted Content-Length is not an allocation bound. */
export async function configRequestBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const reader = request.body?.getReader();

  if (!reader)
    throw new MaisterError("CONFIG", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new MaisterError(
          "CONFIG",
          "The configuration request exceeds 4 KiB.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;

  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new MaisterError(
      "CONFIG",
      "The configuration request must contain valid JSON.",
    );
  }
  const parsed = schema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The configuration request has missing, unknown or invalid fields.",
    );

  return parsed.data;
}

export function configOperationIdentity(
  context: ConfigHttpContext,
  operationId: string,
): ConfigOperationIdentity {
  if (!z.string().uuid().safeParse(operationId).success)
    throw new MaisterError(
      "PRECONDITION",
      "Configuration operation was not found.",
      { details: { httpStatus: 404 } },
    );

  return {
    id: operationId,
    projectId: context.projectId,
    actorUserId: context.actorUserId,
  };
}

export function configErrorResponse(error: unknown): NextResponse {
  const pg = pgErrorOf(error);

  if (
    !isMaisterError(error) &&
    pg &&
    ["55P03", "40001", "40P01"].includes(pg.code)
  ) {
    return configJson(
      {
        code: "CONFLICT",
        message:
          "Configuration changed or another publication is active. Read the current receipt and create a fresh preview when it is settled.",
        details: { reason: "operation_busy" },
      },
      409,
    );
  }
  let cause = error;
  let transportUnavailable = false;

  for (let depth = 0; depth < 5 && cause; depth++) {
    if (typeof cause !== "object") break;
    const candidate = cause as { code?: unknown; cause?: unknown };

    if (
      typeof candidate.code === "string" &&
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(
        candidate.code,
      )
    )
      transportUnavailable = true;
    cause = candidate.cause;
  }
  if (
    !isMaisterError(error) &&
    (transportUnavailable ||
      (pg &&
        (pg.code.startsWith("08") ||
          ["57P01", "57P02", "57P03", "53300", "53400"].includes(pg.code))))
  ) {
    log.warn({ sqlState: pg?.code }, "configuration database unavailable");

    return configJson(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message:
          "Configuration storage is unavailable. Keep the operation ID and read its receipt after storage recovers.",
        details: { reason: "repository_unavailable" },
      },
      503,
    );
  }

  if (!isMaisterError(error)) {
    log.error(
      { errorType: error instanceof Error ? error.name : typeof error },
      "unexpected configuration request failure",
    );

    return configJson(
      {
        code: "CRASH",
        message:
          "Configuration operation failed. Check the operation receipt before retrying.",
      },
      500,
    );
  }
  if (error.details?.httpStatus === 404)
    return configJson(
      {
        code: "PRECONDITION",
        message: "Configuration resource was not found.",
      },
      404,
    );
  const status =
    error.code === "UNAUTHENTICATED"
      ? 401
      : [
            "UNAUTHORIZED",
            "PASSWORD_CHANGE_REQUIRED",
            "ACCOUNT_INACTIVE",
          ].includes(error.code)
        ? 403
        : error.code === "CONFIG"
          ? 422
          : ["CONFLICT", "PRECONDITION"].includes(error.code)
            ? 409
            : error.code === "EXECUTOR_UNAVAILABLE"
              ? 503
              : 500;
  const reason = CONFIG_PERSIST_REASONS.find(
    (candidate) => candidate === error.details?.reason,
  );

  log.warn(
    { code: error.code, reason, status },
    "configuration request refused",
  );

  return configJson(
    {
      code: error.code,
      message: error.message,
      ...(reason ? { details: { reason } } : {}),
    },
    status,
  );
}
