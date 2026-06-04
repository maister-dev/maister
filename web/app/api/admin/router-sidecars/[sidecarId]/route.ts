import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { loadSidecarUsageReferences } from "@/lib/acp-runners/usage";
import { evaluateSidecarReadiness } from "@/lib/acp-runners/readiness";
import { requireGlobalRole } from "@/lib/authz";
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
  name: "api-admin-router-sidecar",
  level: process.env.LOG_LEVEL ?? "info",
});

const secretRefSchema = z
  .string()
  .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, "must be an env:NAME reference");

const patchBodySchema = z
  .object({
    lifecycle: z.enum(["managed", "external"]).optional(),
    commandPreset: z.literal("ccr_start").nullable().optional(),
    configPath: z.string().min(1).nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
    healthcheckUrl: z.string().url().nullable().optional(),
    authTokenRef: secretRefSchema.nullable().optional(),
    readinessStatus: z.enum(["Unknown", "Ready", "NotReady"]).optional(),
    readinessReasons: z.array(z.string().min(1)).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ sidecarId: string }> };
type LoadedSidecar = {
  readonly id: string;
  readonly kind: "ccr";
  readonly lifecycle: "managed" | "external";
  readonly commandPreset?: "ccr_start" | null;
  readonly configPath?: string | null;
  readonly baseUrl?: string | null;
  readonly healthcheckUrl?: string | null;
  readonly authTokenRef?: string | null;
  readonly enabled: boolean;
};

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
    "router sidecar update API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
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

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { sidecarId } = await params;
  let body: z.infer<typeof patchBodySchema>;

  try {
    body = patchBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;
    const rows = await db
      .select()
      .from(platformRouterSidecars)
      .where(eq(platformRouterSidecars.id, sidecarId));
    const currentSidecar = rows[0] as LoadedSidecar | undefined;

    if (!currentSidecar) {
      throw new MaisterError(
        "PRECONDITION",
        `router sidecar not found: ${sidecarId}`,
      );
    }

    if (body.enabled === false) {
      const refs = await loadSidecarUsageReferences(db, sidecarId);

      if (refs.length > 0) {
        throw new MaisterError(
          "CONFLICT",
          `router sidecar ${sidecarId} is referenced by ${refs.length} usage references`,
        );
      }
    }
    const nextSidecar: LoadedSidecar = {
      ...currentSidecar,
      ...body,
    };
    const diagnostics = await loadDiagnosticsForReadiness();
    const readiness = evaluateSidecarReadiness({
      sidecar: {
        id: nextSidecar.id,
        kind: nextSidecar.kind,
        lifecycle: nextSidecar.lifecycle,
        commandPreset: nextSidecar.commandPreset ?? null,
        configPath: nextSidecar.configPath ?? null,
        baseUrl: nextSidecar.baseUrl ?? null,
        healthcheckUrl: nextSidecar.healthcheckUrl ?? null,
        enabled: nextSidecar.enabled,
      },
      diagnostics: diagnostics.diagnostics,
      diagnosticsUnavailableReason: diagnostics.unavailableReason,
    });

    await db
      .update(platformRouterSidecars)
      .set({
        ...body,
        readinessStatus: readiness.status,
        readinessReasons: readiness.reasons,
        updatedAt: new Date(),
      })
      .where(eq(platformRouterSidecars.id, sidecarId));

    log.info({ sidecarId }, "router sidecar updated");

    return NextResponse.json({
      ok: true,
      id: sidecarId,
      readinessStatus: readiness.status,
      readinessReasons: readiness.reasons,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
