import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { evaluateSidecarReadiness } from "@/lib/acp-runners/readiness";
import { sidecarConfigPathSchema } from "@/lib/acp-runners/sidecar-schema";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  checkSupervisorDiagnostics,
  type SupervisorDiagnostics,
} from "@/lib/supervisor-client";

const { platformRouterSidecars } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-admin-router-sidecars",
  level: process.env.LOG_LEVEL ?? "info",
});

const secretRefSchema = z
  .string()
  .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, "must be an env:NAME reference");

const sidecarBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    kind: z.literal("ccr"),
    lifecycle: z.enum(["managed", "external"]),
    commandPreset: z.literal("ccr_start").nullable().optional(),
    configPath: sidecarConfigPathSchema.nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
    healthcheckUrl: z.string().url().nullable().optional(),
    authTokenRef: secretRefSchema.nullable().optional(),
    readinessStatus: z
      .enum(["Unknown", "Ready", "NotReady"])
      .default("Unknown"),
    readinessReasons: z.array(z.string().min(1)).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "router sidecar API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function assertSidecarIdUnused(
  db: any,
  sidecarId: string,
): Promise<void> {
  const rows = await db
    .select({ id: platformRouterSidecars.id })
    .from(platformRouterSidecars)
    .where(eq(platformRouterSidecars.id, sidecarId));

  if (rows[0]) {
    throw new MaisterError(
      "CONFLICT",
      `router sidecar already exists: ${sidecarId}`,
    );
  }
}

async function loadDiagnosticsForReadiness(): Promise<{
  diagnostics: SupervisorDiagnostics | null;
  unavailableReason: string | null;
}> {
  const status = await checkSupervisorDiagnostics();

  if (status.kind === "ready") {
    return {
      diagnostics: status.diagnostics,
      unavailableReason: null,
    };
  }

  return {
    diagnostics: null,
    unavailableReason: status.message,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    return NextResponse.json({
      sidecars: await (getDb() as any).select().from(platformRouterSidecars),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseJson(req).catch(errorResponse);

  if (body instanceof NextResponse) return body;

  const parsed = sidecarBodySchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid POST body: ${parsed.error.message}`),
    );
  }

  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;
    const diagnostics = await loadDiagnosticsForReadiness();
    const readiness = evaluateSidecarReadiness({
      sidecar: {
        id: parsed.data.id,
        kind: parsed.data.kind,
        lifecycle: parsed.data.lifecycle,
        commandPreset: parsed.data.commandPreset ?? null,
        configPath: parsed.data.configPath ?? null,
        baseUrl: parsed.data.baseUrl ?? null,
        healthcheckUrl: parsed.data.healthcheckUrl ?? null,
        enabled: parsed.data.enabled,
      },
      diagnostics: diagnostics.diagnostics,
      diagnosticsUnavailableReason: diagnostics.unavailableReason,
    });

    await assertSidecarIdUnused(db, parsed.data.id);
    await db.insert(platformRouterSidecars).values({
      id: parsed.data.id,
      kind: parsed.data.kind,
      lifecycle: parsed.data.lifecycle,
      commandPreset: parsed.data.commandPreset ?? null,
      configPath: parsed.data.configPath ?? null,
      baseUrl: parsed.data.baseUrl ?? null,
      healthcheckUrl: parsed.data.healthcheckUrl ?? null,
      authTokenRef: parsed.data.authTokenRef ?? null,
      readinessStatus: readiness.status,
      readinessReasons: readiness.reasons,
      enabled: parsed.data.enabled,
    });

    log.info({ sidecarId: parsed.data.id }, "router sidecar created");

    return NextResponse.json(
      {
        ok: true,
        id: parsed.data.id,
        readinessStatus: readiness.status,
        readinessReasons: readiness.reasons,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
