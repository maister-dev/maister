import "server-only";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { platformRunnerPresetRows } from "@/lib/acp-runners/presets";
import { evaluateRunnerReadiness } from "@/lib/acp-runners/readiness";
import {
  getAdapterSupport,
  type PermissionPolicy,
  type ProviderKind,
} from "@/lib/acp-runners/schema";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  checkSupervisorDiagnostics,
  type SupervisorDiagnostics,
} from "@/lib/supervisor-client";

const { platformAcpRunners, platformRouterSidecars, platformRuntimeSettings } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-admin-acp-runners",
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

const runnerBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    adapter: z.enum(["claude", "codex"]),
    model: z.string().trim().min(1),
    provider: providerSchema,
    permissionPolicy: z
      .enum(["default", "dangerously_skip_permissions"])
      .default("default"),
    sidecarId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const settingsBodySchema = z
  .object({
    defaultRunnerId: z.string().min(1).optional(),
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
    "platform ACP runner API error",
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

function capabilityAgentForAdapter(
  adapter: "claude" | "codex",
): "claude" | "codex" {
  return adapter;
}

function assertProviderSupported(args: {
  adapter: "claude" | "codex";
  providerKind: ProviderKind;
  permissionPolicy: PermissionPolicy;
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

async function assertReadyRunner(db: any, runnerId: string): Promise<void> {
  const rows = await db
    .select({
      id: platformAcpRunners.id,
      adapter: platformAcpRunners.adapter,
      capabilityAgent: platformAcpRunners.capabilityAgent,
      enabled: platformAcpRunners.enabled,
      permissionPolicy: platformAcpRunners.permissionPolicy,
      provider: platformAcpRunners.provider,
      readinessStatus: platformAcpRunners.readinessStatus,
      sidecarId: platformAcpRunners.sidecarId,
    })
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, runnerId));
  const runner = rows[0];

  if (!runner) {
    throw new MaisterError("PRECONDITION", `ACP runner not found: ${runnerId}`);
  }
  if (runner.enabled === false || runner.readinessStatus !== "Ready") {
    throw new MaisterError(
      "PRECONDITION",
      `ACP runner is not ready: ${runnerId}`,
    );
  }

  const sidecarRows = runner.sidecarId
    ? await db
        .select()
        .from(platformRouterSidecars)
        .where(eq(platformRouterSidecars.id, runner.sidecarId))
    : [];
  const diagnostics = await loadDiagnosticsForReadiness();
  const readiness = evaluateRunnerReadiness({
    runner: {
      adapter: runner.adapter,
      capabilityAgent: runner.capabilityAgent,
      enabled: runner.enabled,
      permissionPolicy: runner.permissionPolicy,
      provider: runner.provider,
      sidecarId: runner.sidecarId ?? null,
    },
    diagnostics: diagnostics.diagnostics,
    sidecar: sidecarRows[0] ?? null,
  });

  if (readiness.status !== "Ready") {
    throw new MaisterError(
      "PRECONDITION",
      `ACP runner is not ready by supervisor diagnostics: ${runnerId}`,
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

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;
    const [runners, sidecars, settingsRows] = await Promise.all([
      db.select().from(platformAcpRunners),
      db.select().from(platformRouterSidecars),
      db.select().from(platformRuntimeSettings),
    ]);

    return NextResponse.json({
      adapters: getAdapterSupport(),
      defaultRunnerId: settingsRows[0]?.defaultRunnerId ?? null,
      presets: platformRunnerPresetRows(),
      runners,
      sidecars,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = runnerBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }
    assertProviderSupported({
      adapter: parsed.data.adapter,
      providerKind: parsed.data.provider.kind,
      permissionPolicy: parsed.data.permissionPolicy,
    });

    const db = getDb() as any;
    const diagnostics = await loadDiagnosticsForReadiness();
    const sidecarRows =
      parsed.data.sidecarId !== null && parsed.data.sidecarId !== undefined
        ? await db
            .select()
            .from(platformRouterSidecars)
            .where(eq(platformRouterSidecars.id, parsed.data.sidecarId))
        : [];
    const sidecar = sidecarRows[0] ?? null;
    const readiness = evaluateRunnerReadiness({
      runner: {
        adapter: parsed.data.adapter,
        capabilityAgent: capabilityAgentForAdapter(parsed.data.adapter),
        enabled: parsed.data.enabled,
        permissionPolicy: parsed.data.permissionPolicy,
        provider: parsed.data.provider,
        sidecarId: parsed.data.sidecarId ?? null,
      },
      diagnostics: diagnostics.diagnostics,
      sidecar,
    });

    // Race-safe create: rely on the id primary-key constraint, not a
    // read-then-write SELECT (two concurrent POSTs both pass the SELECT and the
    // second would raise a raw 23505 -> 500). onConflictDoNothing + an empty
    // returning() yields the documented 409 without a unique-violation crash.
    const inserted = await db
      .insert(platformAcpRunners)
      .values({
        id: parsed.data.id,
        adapter: parsed.data.adapter,
        capabilityAgent: capabilityAgentForAdapter(parsed.data.adapter),
        model: parsed.data.model,
        provider: parsed.data.provider,
        permissionPolicy: parsed.data.permissionPolicy,
        sidecarId: parsed.data.sidecarId ?? null,
        enabled: parsed.data.enabled,
        readinessStatus: readiness.status,
        readinessReasons: readiness.reasons,
      })
      .onConflictDoNothing()
      .returning({ id: platformAcpRunners.id });

    if (inserted.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `ACP runner already exists: ${parsed.data.id}`,
      );
    }

    return NextResponse.json({ ok: true, id: parsed.data.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = settingsBodySchema.safeParse(await parseJson(req));

    if (!parsed.success || parsed.data.defaultRunnerId === undefined) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.success ? "no fields to update" : parsed.error.message}`,
      );
    }

    const db = getDb() as any;

    await assertReadyRunner(db, parsed.data.defaultRunnerId);
    await db
      .insert(platformRuntimeSettings)
      .values({
        id: "singleton",
        defaultRunnerId: parsed.data.defaultRunnerId,
      })
      .onConflictDoUpdate({
        target: platformRuntimeSettings.id,
        set: {
          defaultRunnerId: parsed.data.defaultRunnerId,
          updatedAt: new Date(),
        },
      });

    log.info(
      { id: randomUUID(), defaultRunnerId: parsed.data.defaultRunnerId },
      "platform ACP default runner updated",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
