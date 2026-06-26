import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RunnerSlotKind } from "@/lib/acp-runners/runner-slots";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { enumerateRunnerSlots } from "@/lib/acp-runners/runner-slots";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

const { flowRunnerRemaps, flows, platformAcpRunners, projects } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-flow-runner-remaps",
  level: process.env.LOG_LEVEL ?? "info",
});

// M42 (ADR-114): bind one per-slot runner mapping, keyed by `slot_key` within a
// flow revision (replaces the legacy per-step `remapId` body). `slot_key` is
// validated ∈ the revision-declared slots; `mappedRunnerId` ∈ the platform
// runner catalog (allow-list). DB-only — no downstream side-effect.
const patchBodySchema = z
  .object({
    flowRevisionId: z.string().min(1),
    slotKey: z.string().min(1),
    mappedRunnerId: z.string().min(1).nullable(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

function httpStatusForCode(code: string): number {
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

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "project Flow runner remap API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadProject(
  db: any,
  slug: string,
): Promise<Record<string, any>> {
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

async function assertEnabledRunner(
  db: any,
  runnerId: string | null,
): Promise<void> {
  if (runnerId === null) return;

  const runnerRows = await db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, runnerId));
  const runner = runnerRows[0];

  if (!runner) {
    throw new MaisterError("PRECONDITION", `ACP runner not found: ${runnerId}`);
  }
  if (runner.enabled === false) {
    throw new MaisterError(
      "PRECONDITION",
      `ACP runner is disabled: ${runnerId}`,
    );
  }
  if (runner.readinessStatus !== "Ready") {
    throw new MaisterError(
      "PRECONDITION",
      `ACP runner is not ready: ${runnerId}`,
    );
  }
}

function slotKindFromKey(slotKey: string): RunnerSlotKind {
  if (slotKey.startsWith("session:")) return "session";
  if (slotKey.endsWith(":synthesizer")) return "consensus_synthesizer";

  return "consensus_participant";
}

// Per-revision { slotKey -> {kind, label} }, derived by compiling each project
// flow's enabled manifest. Used to enrich binding rows with a human label for
// the connect-time screen.
function slotMetaByRevision(
  flowRows: readonly Record<string, any>[],
): Map<string, Map<string, { kind: RunnerSlotKind; label: string }>> {
  const byRevision = new Map<
    string,
    Map<string, { kind: RunnerSlotKind; label: string }>
  >();

  for (const flow of flowRows) {
    if (!flow.enabledRevisionId || !flow.manifest) continue;

    try {
      const slots = enumerateRunnerSlots(flow.manifest as FlowYamlV1);
      const byKey = new Map<string, { kind: RunnerSlotKind; label: string }>();

      for (const slot of slots) {
        byKey.set(slot.slotKey, { kind: slot.kind, label: slot.label });
      }

      byRevision.set(flow.enabledRevisionId as string, byKey);
    } catch (err) {
      log.warn(
        {
          flowId: flow.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to enumerate flow runner slots for binding labels",
      );
    }
  }

  return byRevision;
}

function remapView(args: {
  remap: Record<string, any>;
  flowByRevisionId: ReadonlyMap<string, Record<string, any>>;
  slotMeta: ReadonlyMap<
    string,
    ReadonlyMap<string, { kind: RunnerSlotKind; label: string }>
  >;
}): Record<string, unknown> {
  const flow = args.flowByRevisionId.get(args.remap.flowRevisionId);
  const meta = args.slotMeta
    .get(args.remap.flowRevisionId)
    ?.get(args.remap.slotKey);

  return {
    id: args.remap.id,
    flowId: flow?.id ?? null,
    flowRef: flow?.flowRefId ?? args.remap.flowRevisionId,
    flowRevisionId: args.remap.flowRevisionId,
    slotKey: args.remap.slotKey,
    kind: meta?.kind ?? slotKindFromKey(args.remap.slotKey),
    label: meta?.label ?? args.remap.slotKey,
    mappedRunnerId: args.remap.mappedRunnerId,
    status: args.remap.status,
  };
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const scopeRevisionId = req.nextUrl.searchParams.get("flowRevisionId");

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const project = await loadProject(db, slug);

    await requireProjectAction(project.id, "editSettings");

    const [flowRows, remapRows] = await Promise.all([
      db
        .select({
          id: flows.id,
          flowRefId: flows.flowRefId,
          enabledRevisionId: flows.enabledRevisionId,
          manifest: flows.manifest,
        })
        .from(flows)
        .where(eq(flows.projectId, project.id)),
      db
        .select()
        .from(flowRunnerRemaps)
        .where(eq(flowRunnerRemaps.projectId, project.id)),
    ]);
    const flowByRevisionId = new Map<string, Record<string, any>>(
      flowRows
        .filter((flow: Record<string, any>) => flow.enabledRevisionId)
        .map((flow: Record<string, any>) => [
          flow.enabledRevisionId as string,
          flow,
        ]),
    );
    const slotMeta = slotMetaByRevision(flowRows);
    const visibleRemaps = (remapRows as Record<string, any>[]).filter(
      (remap) => !scopeRevisionId || remap.flowRevisionId === scopeRevisionId,
    );

    return NextResponse.json({
      remaps: visibleRemaps.map((remap) =>
        remapView({ remap, flowByRevisionId, slotMeta }),
      ),
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  let body: z.infer<typeof patchBodySchema>;

  try {
    body = patchBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${err instanceof Error ? err.message : String(err)}`,
      ),
      slug,
    );
  }

  try {
    await requireActiveSession();

    const db = getDb() as any;
    const project = await loadProject(db, slug);

    await requireProjectAction(project.id, "editSettings");

    // The revision must belong to a flow in THIS project (server-state); the
    // slot_key must be one the revision actually declares.
    const flowRows = await db
      .select({
        id: flows.id,
        flowRefId: flows.flowRefId,
        enabledRevisionId: flows.enabledRevisionId,
        manifest: flows.manifest,
      })
      .from(flows)
      .where(
        and(
          eq(flows.projectId, project.id),
          eq(flows.enabledRevisionId, body.flowRevisionId),
        ),
      );
    const flow = flowRows[0];

    if (!flow || !flow.manifest) {
      throw new MaisterError(
        "CONFLICT",
        `flow revision not found in project: ${body.flowRevisionId}`,
      );
    }

    const declaredSlots = new Set(
      enumerateRunnerSlots(flow.manifest as FlowYamlV1).map(
        (slot) => slot.slotKey,
      ),
    );

    if (!declaredSlots.has(body.slotKey)) {
      throw new MaisterError(
        "CONFLICT",
        `slot_key "${body.slotKey}" is not declared by flow revision ${body.flowRevisionId}`,
      );
    }

    await assertEnabledRunner(db, body.mappedRunnerId);

    const status = body.mappedRunnerId ? "Mapped" : "Pending";
    const existingRows = await db
      .select()
      .from(flowRunnerRemaps)
      .where(
        and(
          eq(flowRunnerRemaps.projectId, project.id),
          eq(flowRunnerRemaps.flowRevisionId, body.flowRevisionId),
          eq(flowRunnerRemaps.slotKey, body.slotKey),
        ),
      );
    const existing = existingRows[0];

    if (existing) {
      await db
        .update(flowRunnerRemaps)
        .set({
          mappedRunnerId: body.mappedRunnerId,
          status,
          updatedAt: new Date(),
        })
        .where(eq(flowRunnerRemaps.id, existing.id));
    } else {
      await db.insert(flowRunnerRemaps).values({
        id: randomUUID(),
        projectId: project.id,
        flowRevisionId: body.flowRevisionId,
        slotKey: body.slotKey,
        mappedRunnerId: body.mappedRunnerId,
        status,
      });
    }

    log.info(
      {
        projectId: project.id,
        flowRevisionId: body.flowRevisionId,
        slotKey: body.slotKey,
        mappedRunnerId: body.mappedRunnerId,
        status,
      },
      "Flow ACP runner slot binding saved",
    );

    return NextResponse.json({
      remap: {
        flowRevisionId: body.flowRevisionId,
        slotKey: body.slotKey,
        status,
        mappedRunnerId: body.mappedRunnerId,
      },
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
