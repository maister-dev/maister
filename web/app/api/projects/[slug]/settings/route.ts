import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  assertBrainProvisioned,
  assertBrainSchemaApplied,
} from "@/lib/brain/guard";
import {
  getBrainSettings,
  isBrainFullyConfigured,
  reconcileBrainIndexJobs,
} from "@/lib/brain/settings";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { taskQueueSettingsSchema } from "@/lib/tasks/queue-settings";

const { platformAcpRunners, projects } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-project-settings",
  level: process.env.LOG_LEVEL ?? "info",
});

const patchBodySchema = z
  .object({
    runnerId: z.string().min(1).nullable().optional(),
    deliveryPolicyDefault: storedDeliveryPolicySchema.nullable().optional(),
    // ADR-121 §4.3: per-project queue settings. `null` clears the override (env
    // defaults apply). `.strict()` + `maxInFlightAuto.min(1)` reject bad input → 422.
    taskQueueSettings: taskQueueSettingsSchema.nullable().optional(),
    // ADR-122: toggle the Project Brain for this repo. Enabling refuses CONFIG
    // unless the platform embedding config AND distill_model are set (enable-gate).
    brainEnabled: z.boolean().optional(),
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
    "project settings API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    // Auth-first (Codex-4): authenticate + resolve + authorize BEFORE touching the
    // request body, so an unauthenticated caller gets 401/403 and can never probe
    // the body schema or force body parsing via a validation error.
    await requireActiveSession();

    const db = getDb() as any;
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "editSettings");

    let body: z.infer<typeof patchBodySchema>;

    try {
      body = patchBodySchema.parse(await req.json());
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (body.runnerId !== undefined && body.runnerId !== null) {
      const runnerRows = await db
        .select()
        .from(platformAcpRunners)
        .where(eq(platformAcpRunners.id, body.runnerId));
      const runner = runnerRows[0];

      if (!runner) {
        throw new MaisterError(
          "PRECONDITION",
          `ACP runner not found: ${body.runnerId}`,
        );
      }
      if (runner.enabled === false) {
        throw new MaisterError(
          "PRECONDITION",
          `ACP runner is disabled: ${body.runnerId}`,
        );
      }
      if (runner.readinessStatus !== "Ready") {
        throw new MaisterError(
          "PRECONDITION",
          `ACP runner is not ready: ${body.runnerId}`,
        );
      }
    }

    // ADR-122 enable-gate: a project can never be enabled into an
    // unharvest-able state — platform embedding config + distill_model first.
    if (body.brainEnabled === true) {
      // SQLite → 409 PRECONDITION (E-11) before the settings query; a Postgres
      // that never ran `db:migrate:brain` refuses with the exact command
      // instead of letting harvest/recall hit raw 42P01s post-enable.
      assertBrainProvisioned();
      await assertBrainSchemaApplied(db);

      const brainSettings = await getBrainSettings(db);

      if (!isBrainFullyConfigured(brainSettings)) {
        throw new MaisterError(
          "CONFIG",
          "Project Brain cannot be enabled until the platform embedding provider and distill model are configured",
        );
      }
    }

    const update: Record<string, unknown> = {};

    if (body.runnerId !== undefined) {
      update.defaultRunnerId = body.runnerId;
    }
    if (body.deliveryPolicyDefault !== undefined) {
      update.deliveryPolicyDefault = body.deliveryPolicyDefault;
    }
    if (body.taskQueueSettings !== undefined) {
      update.taskQueueSettings = body.taskQueueSettings;
    }
    if (body.brainEnabled !== undefined) {
      update.brainEnabled = body.brainEnabled;
    }

    if (Object.keys(update).length === 0) {
      throw new MaisterError("CONFIG", "PATCH body contains no settings");
    }

    await db.update(projects).set(update).where(eq(projects.id, project.id));

    // ADR-122: a project re-enabled AFTER a generation switch has old-generation
    // embeddings only — reconcile-enqueue a reindex job so its vector leg
    // catches up (no-op when coverage is current or a job is already live).
    // Best-effort: the settings-save reconcile + reindex sweep are the belt.
    if (body.brainEnabled === true) {
      try {
        await reconcileBrainIndexJobs(db, {
          projectId: project.id,
          reason: "manual",
        });
      } catch (err) {
        log.warn(
          {
            projectId: project.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "brain reindex reconcile on enable failed (sweep will catch up)",
        );
      }
    }

    log.info(
      {
        projectId: project.id,
        runnerId: body.runnerId,
        deliveryPolicyDefault: body.deliveryPolicyDefault,
      },
      "project settings updated",
    );

    return NextResponse.json({
      ok: true,
      projectId: project.id,
      defaultRunnerId:
        body.runnerId === undefined ? project.defaultRunnerId : body.runnerId,
      deliveryPolicyDefault:
        body.deliveryPolicyDefault === undefined
          ? project.deliveryPolicyDefault
          : body.deliveryPolicyDefault,
      taskQueueSettings:
        body.taskQueueSettings === undefined
          ? project.taskQueueSettings
          : body.taskQueueSettings,
    });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
