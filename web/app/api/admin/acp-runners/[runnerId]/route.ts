import "server-only";

import type { PlatformRunnerProvider } from "@/lib/db/schema";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { evaluateRunnerReadiness } from "@/lib/acp-runners/readiness";
import {
  getAdapterSupport,
  type PermissionPolicy,
  type ProviderKind,
} from "@/lib/acp-runners/schema";
import {
  loadRunnerUsageReferences,
  type RunnerUsageReference,
} from "@/lib/acp-runners/usage";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  checkSupervisorDiagnostics,
  type SupervisorDiagnostics,
} from "@/lib/supervisor-client";

const { platformAcpRunners, platformRouterSidecars } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-acp-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

const providerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anthropic") }).strict(),
  z
    .object({
      kind: z.literal("anthropic_compatible"),
      baseUrl: z.string().url().optional(),
      authToken: z
        .string()
        .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("openai") }).strict(),
  z
    .object({
      kind: z.literal("openai_compatible"),
      baseUrl: z.string().url().optional(),
      apiKey: z
        .string()
        .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
      wireApi: z.literal("responses").optional(),
    })
    .strict(),
]);

const patchBodySchema = z
  .object({
    model: z.string().min(1).optional(),
    provider: providerSchema.optional(),
    permissionPolicy: z
      .enum(["default", "dangerously_skip_permissions"])
      .optional(),
    sidecarId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    readinessStatus: z.enum(["Unknown", "Ready", "NotReady"]).optional(),
    readinessReasons: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "no fields to update",
  });

type RouteParams = { params: Promise<{ runnerId: string }> };
type LoadedRunner = {
  readonly adapter: "claude" | "codex";
  readonly capabilityAgent: "claude" | "codex";
  readonly enabled: boolean;
  readonly permissionPolicy: "default" | "dangerously_skip_permissions";
  readonly provider: PlatformRunnerProvider;
  readonly sidecarId?: string | null;
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

function errorResponse(err: unknown, runnerId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { runnerId, err: err instanceof Error ? err.message : String(err) },
    "platform ACP runner mutation error",
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

async function loadDiagnosticsForReadiness(): Promise<{
  diagnostics: SupervisorDiagnostics | null;
}> {
  const status = await checkSupervisorDiagnostics();

  return {
    diagnostics: status.kind === "ready" ? status.diagnostics : null,
  };
}

async function loadRunner(db: any, runnerId: string): Promise<LoadedRunner> {
  const rows = await db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, runnerId));
  const runner = rows[0] as LoadedRunner | undefined;

  if (!runner) {
    throw new MaisterError("PRECONDITION", `ACP runner not found: ${runnerId}`);
  }

  return runner;
}

function assertProviderSupported(args: {
  readonly adapter: "claude" | "codex";
  readonly providerKind: ProviderKind;
  readonly permissionPolicy: PermissionPolicy;
}): void {
  const adapter = getAdapterSupport().find((item) => item.id === args.adapter);

  if (!adapter) {
    throw new MaisterError("CONFIG", `unsupported adapter: ${args.adapter}`);
  }
  if (!adapter.providerKinds.includes(args.providerKind)) {
    throw new MaisterError(
      "CONFIG",
      `provider ${args.providerKind} is not supported by adapter ${args.adapter}`,
    );
  }
  if (!adapter.permissionPolicies.includes(args.permissionPolicy)) {
    throw new MaisterError(
      "CONFIG",
      `permission policy ${args.permissionPolicy} is not supported by adapter ${args.adapter}`,
    );
  }
}

async function assertCanDisable(
  db: any,
  runnerId: string,
  enabled: boolean | undefined,
): Promise<void> {
  if (enabled !== false) return;

  const refs = await loadRunnerUsageReferences(db, runnerId);

  if (refs.length > 0) {
    throw new MaisterError(
      "CONFLICT",
      `cannot disable ACP runner ${runnerId}; referenced by ${refs.length} usage references`,
    );
  }
}

function summarizeRefs(refs: RunnerUsageReference[]): string {
  return refs
    .map((ref) => {
      switch (ref.kind) {
        case "platformDefault":
          return "platformDefault";
        case "projectDefault":
          return `projectDefault:${ref.projectId}`;
        case "platformFlowDefault":
          return `platformFlowDefault:${ref.flowRevisionId}`;
        case "projectFlowDefault":
          return `projectFlowDefault:${ref.projectId}`;
        case "flowStepRemap":
          return `flowStepRemap:${ref.stepId}`;
        case "activeRun":
          return `activeRun:${ref.runId}`;
        case "historicalRunSnapshot":
          return `historicalRunSnapshot:${ref.runId}`;
        case "scratchRun":
          return `scratchRun:${ref.runId}`;
      }
    })
    .join(", ");
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runnerId } = await params;

  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;

    await loadRunner(db, runnerId);

    const refs = await loadRunnerUsageReferences(db, runnerId);

    if (refs.length > 0) {
      log.info(
        { runnerId, refs: refs.length },
        "platform ACP runner delete blocked",
      );
      throw new MaisterError(
        "CONFLICT",
        `cannot delete ACP runner ${runnerId}; referenced by: ${summarizeRefs(refs)}`,
      );
    }

    await db
      .delete(platformAcpRunners)
      .where(eq(platformAcpRunners.id, runnerId));

    log.info({ runnerId }, "platform ACP runner deleted");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, runnerId);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runnerId } = await params;
  const body = await parseJson(req).catch((err) =>
    errorResponse(err, runnerId),
  );

  if (body instanceof NextResponse) return body;

  const parsed = patchBodySchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid PATCH body: ${parsed.error.message}`),
      runnerId,
    );
  }

  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;

    const currentRunner = await loadRunner(db, runnerId);

    await assertCanDisable(db, runnerId, parsed.data.enabled);
    const nextRunner: LoadedRunner = {
      ...currentRunner,
      ...parsed.data,
    };

    assertProviderSupported({
      adapter: nextRunner.adapter,
      providerKind: nextRunner.provider.kind,
      permissionPolicy: nextRunner.permissionPolicy,
    });
    const sidecarRows = nextRunner.sidecarId
      ? await db
          .select()
          .from(platformRouterSidecars)
          .where(eq(platformRouterSidecars.id, nextRunner.sidecarId))
      : [];
    const diagnostics = await loadDiagnosticsForReadiness();
    const readiness = evaluateRunnerReadiness({
      runner: {
        adapter: nextRunner.adapter,
        capabilityAgent: nextRunner.capabilityAgent,
        enabled: nextRunner.enabled,
        permissionPolicy: nextRunner.permissionPolicy,
        provider: nextRunner.provider,
        sidecarId: nextRunner.sidecarId ?? null,
      },
      diagnostics: diagnostics.diagnostics,
      sidecar: sidecarRows[0] ?? null,
    });

    await db
      .update(platformAcpRunners)
      .set({
        ...parsed.data,
        readinessStatus: readiness.status,
        readinessReasons: readiness.reasons,
        updatedAt: new Date(),
      })
      .where(eq(platformAcpRunners.id, runnerId));

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, runnerId);
  }
}
