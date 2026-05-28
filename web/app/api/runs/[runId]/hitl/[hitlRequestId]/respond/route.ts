import "server-only";

import path from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { atomicWriteJson } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { runFlow } from "@/lib/flows/runner";
import { deliverPermission } from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, projects, runs } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-hitl",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_RUN_STATUS = new Set([
  "Failed",
  "Crashed",
  "Done",
  "Abandoned",
]);

const bodySchema = z.object({
  optionId: z.string().min(1).optional(),
  response: z.unknown().optional(),
});

function errorResponse(
  err: unknown,
  ctx: { runId: string; hitlRequestId: string },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "respond error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "respond unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "HITL_TIMEOUT":
      return 410;
    case "CONFIG":
      return 400;
    case "NEEDS_INPUT":
      return 422;
    default:
      return 500;
  }
}

function runtimeRoot(): string {
  return process.env.MAISTER_RUNTIME_ROOT ?? process.cwd();
}

type RouteParams = { params: Promise<{ runId: string; hitlRequestId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;
  const startedAt = Date.now();

  let body: z.infer<typeof bodySchema>;

  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid response body: ${(err as Error).message}`,
      ),
      { runId, hitlRequestId },
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getDb() as any;
    const hitlRows = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitlRequestId));
    const hitlRow = hitlRows[0];

    if (!hitlRow) {
      throw new MaisterError(
        "PRECONDITION",
        `hitl request not found: ${hitlRequestId}`,
      );
    }
    if (hitlRow.runId !== runId) {
      throw new MaisterError(
        "PRECONDITION",
        `hitl request ${hitlRequestId} does not belong to run ${runId}`,
      );
    }

    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    const runRow = runRows[0];

    if (!runRow) {
      throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
    }

    if (hitlRow.kind === "permission") {
      return await handlePermissionResponse({
        db,
        hitlRow,
        runRow,
        body,
        runId,
        hitlRequestId,
        startedAt,
      });
    }

    return await handleFormHumanResponse({
      db,
      hitlRow,
      runRow,
      body,
      runId,
      hitlRequestId,
      startedAt,
    });
  } catch (err) {
    return errorResponse(err, { runId, hitlRequestId });
  }
}

type HandlerArgs = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hitlRow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runRow: any;
  body: z.infer<typeof bodySchema>;
  runId: string;
  hitlRequestId: string;
  startedAt: number;
};

async function handlePermissionResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, body, runId, hitlRequestId, startedAt } = args;
  const optionId = body.optionId;

  if (typeof optionId !== "string" || optionId.length === 0) {
    throw new MaisterError(
      "CONFIG",
      "optionId is required for kind=permission",
    );
  }

  const schema = hitlRow.schema as {
    requestId: string;
    supervisorSessionId: string;
    options?: Array<{ optionId: string }>;
  };

  if (Array.isArray(schema.options)) {
    const valid = schema.options.some((o) => o.optionId === optionId);

    if (!valid) {
      throw new MaisterError(
        "CONFIG",
        `optionId ${optionId} not in declared options`,
      );
    }
  }

  // Phase 1: store the user's chosen optionId (overwriteable on retry)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    const lockedHitl = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitlRequestId));
    const lockedRun = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId));

    if (!lockedHitl[0] || !lockedRun[0]) {
      throw new MaisterError("PRECONDITION", "row vanished mid-transaction");
    }
    if (TERMINAL_RUN_STATUS.has(lockedRun[0].status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is terminal (${lockedRun[0].status}); cannot respond`,
      );
    }
    if (lockedHitl[0].respondedAt) {
      throw new MaisterError(
        "CONFLICT",
        "hitl request already delivered",
      );
    }

    await tx
      .update(hitlRequests)
      .set({ response: { optionId } })
      .where(eq(hitlRequests.id, hitlRequestId));
  });

  // Phase 2: deliver to supervisor, then mark respondedAt
  try {
    await deliverPermission(
      schema.supervisorSessionId,
      schema.requestId,
      optionId,
    );

    await db
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
        ),
      );

    log.info(
      {
        runId,
        hitlRequestId,
        kind: "permission",
        phase: "delivered",
        supervisorAck: true,
        latencyMs: Date.now() - startedAt,
      },
      "permission delivered",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Running" },
      { status: 200 },
    );
  } catch (err) {
    if (isMaisterError(err) && err.code === "HITL_TIMEOUT") {
      // Terminal failure — supervisor lost the deferred.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.transaction(async (tx: any) => {
        await tx
          .update(runs)
          .set({ status: "Failed", endedAt: new Date() })
          .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")));
        await tx
          .update(hitlRequests)
          .set({ respondedAt: new Date() })
          .where(eq(hitlRequests.id, hitlRequestId));
      });

      log.warn(
        {
          runId,
          hitlRequestId,
          kind: "permission",
          phase: "terminal-410",
          latencyMs: Date.now() - startedAt,
        },
        "permission deferred expired — run transitioned to Failed",
      );

      return NextResponse.json(
        {
          code: "HITL_TIMEOUT",
          message:
            "permission window expired before response was delivered",
        },
        { status: 410 },
      );
    }

    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        {
          runId,
          hitlRequestId,
          kind: "permission",
          phase: "retry-503",
          latencyMs: Date.now() - startedAt,
        },
        "supervisor unreachable — response retryable",
      );

      return NextResponse.json(
        {
          code: "EXECUTOR_UNAVAILABLE",
          message: "supervisor unreachable; retry the response",
        },
        { status: 503 },
      );
    }

    throw err;
  }
}

async function handleFormHumanResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, runRow, body, runId, hitlRequestId, startedAt } = args;
  const response = body.response;

  if (response === undefined) {
    throw new MaisterError(
      "CONFIG",
      `response is required for kind=${hitlRow.kind}`,
    );
  }

  if (TERMINAL_RUN_STATUS.has(runRow.status)) {
    throw new MaisterError(
      "CONFLICT",
      `run is terminal (${runRow.status}); cannot respond`,
    );
  }
  if (hitlRow.respondedAt) {
    throw new MaisterError("CONFLICT", "hitl request already delivered");
  }

  const projectRows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, runRow.projectId));
  const projectSlug = projectRows[0]?.slug;

  if (!projectSlug) {
    throw new MaisterError("PRECONDITION", "project slug not found");
  }

  const inputPath = path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "runs",
    runId,
    `input-${hitlRow.stepId}.json`,
  );

  try {
    await atomicWriteJson(inputPath, response);
  } catch (err) {
    log.warn(
      {
        runId,
        hitlRequestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "input artifact write failed — retryable",
    );

    return NextResponse.json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message: "could not persist input artifact; retry",
      },
      { status: 503 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    const lockedHitl = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitlRequestId));
    const lockedRun = await tx.select().from(runs).where(eq(runs.id, runId));

    if (!lockedHitl[0] || !lockedRun[0]) {
      throw new MaisterError("PRECONDITION", "row vanished mid-transaction");
    }
    if (TERMINAL_RUN_STATUS.has(lockedRun[0].status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is terminal (${lockedRun[0].status}); cannot respond`,
      );
    }
    if (lockedHitl[0].respondedAt) {
      throw new MaisterError("CONFLICT", "hitl request already delivered");
    }

    // Mark the user's response as durably received WITHOUT flipping
    // runs.status to Running here. runFlow's resume path requires the
    // run to still be in NeedsInput so it walks to currentStepId
    // instead of restarting from step 0. The runner does the
    // NeedsInput→Running transition once it has accepted the work.
    await tx
      .update(hitlRequests)
      .set({ response, respondedAt: new Date() })
      .where(eq(hitlRequests.id, hitlRequestId));
  });

  queueMicrotask(() =>
    void runFlow(runId).catch((err: unknown) =>
      log.error(
        { runId, err: err instanceof Error ? err.message : String(err) },
        "background runFlow on resume failed",
      ),
    ),
  );

  log.info(
    {
      runId,
      hitlRequestId,
      kind: hitlRow.kind,
      phase: "delivered",
      supervisorAck: false,
      latencyMs: Date.now() - startedAt,
    },
    "form/human response delivered",
  );

  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput" },
    { status: 200 },
  );
}
