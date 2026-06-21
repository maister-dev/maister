import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  loadSidecarUsageReferences,
  type SidecarUsageReference,
} from "@/lib/acp-runners/usage";
import { evaluateSidecarReadiness } from "@/lib/acp-runners/readiness";
import { sidecarConfigPathSchema } from "@/lib/acp-runners/sidecar-schema";
import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  checkSupervisorDiagnostics,
  stopSidecar,
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
    configPath: sidecarConfigPathSchema.nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
    healthcheckUrl: z.string().url().nullable().optional(),
    authTokenRef: secretRefSchema.nullable().optional(),
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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
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

function summarizeSidecarRefs(refs: SidecarUsageReference[]): string {
  return refs.map((ref) => `runner:${ref.runnerId}`).join(", ");
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { sidecarId } = await params;

  try {
    // Auth-first: the admin check precedes any read or side-effect.
    await requireGlobalRole("admin");

    const db = getDb() as any;

    // The usage-guard, the managed stop, and the row delete run as ONE
    // serialized transaction. The `FOR UPDATE` lock on the sidecar row is
    // load-bearing: a runner binding to this sidecar takes a `FOR KEY SHARE`
    // lock on the same row (FK enforcement), which conflicts with `FOR UPDATE`
    // — so no runner can be bound between the usage-guard read and the delete.
    // Without it the sidecar_id FK (onDelete:"set null") would let a racing
    // bind be silently unbound by the delete. (`for("update")` is a
    // Postgres-only row lock; SQLite relies on its own write serialization.)
    await db.transaction(async (tx: any) => {
      const rows = await tx
        .select()
        .from(platformRouterSidecars)
        .where(eq(platformRouterSidecars.id, sidecarId))
        .for("update");
      const sidecar = rows[0] as LoadedSidecar | undefined;

      if (!sidecar) {
        throw new MaisterError(
          "PRECONDITION",
          `router sidecar not found: ${sidecarId}`,
        );
      }

      const refs = await loadSidecarUsageReferences(tx, sidecarId);

      if (refs.length > 0) {
        log.info(
          { sidecarId, refs: refs.length },
          "router sidecar delete blocked",
        );
        throw new MaisterError(
          "CONFLICT",
          `cannot delete router sidecar ${sidecarId}; referenced by: ${summarizeSidecarRefs(refs)}`,
        );
      }

      // A bare row delete would orphan a live managed CCR process (no row left
      // to stop it later). The stop must be CONFIRMED before the row — the only
      // handle to the process — is removed: an unconfirmed stop (supervisor
      // down/timeout) aborts the transaction so the row survives for a retry.
      if (sidecar.lifecycle === "managed") {
        try {
          await stopSidecar(sidecarId);
        } catch (err) {
          log.error(
            {
              sidecarId,
              err: err instanceof Error ? err.message : String(err),
            },
            "router sidecar delete aborted: managed stop not confirmed",
          );
          throw err;
        }
      }

      await tx
        .delete(platformRouterSidecars)
        .where(eq(platformRouterSidecars.id, sidecarId));
    });

    log.info({ sidecarId }, "router sidecar deleted");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { sidecarId } = await params;

  try {
    // Auth-first: the admin check precedes reading/validating the body.
    await requireGlobalRole("admin");

    let body: z.infer<typeof patchBodySchema>;

    try {
      body = patchBodySchema.parse(await req.json());
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
