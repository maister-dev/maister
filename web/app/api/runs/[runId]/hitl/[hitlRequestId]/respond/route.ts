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
import { assertHitlResponse } from "@/lib/flows/hitl-validate";
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

function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

// Acquire a row-level lock on the HITL request row inside a transaction.
// Postgres: SELECT ... FOR UPDATE. SQLite: deferred-write semantics rely on
// the single-writer lock so the no-op `.where()` is correct.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lockHitlRow(tx: any, hitlRequestId: string): Promise<any> {
  if (isPostgres()) {
    const rows = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitlRequestId))
      .for("update");

    return rows[0];
  }
  const rows = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));

  return rows[0];
}

// Schedule a runner wake-up for a delivered HITL row. Called from both
// the first-success path and the same-payload retry path so a process
// restart between Phase 3 commit and the original microtask cannot
// strand the run in NeedsInput.
function scheduleResume(runId: string): void {
  queueMicrotask(() =>
    void runFlow(runId).catch((err: unknown) =>
      log.error(
        { runId, err: err instanceof Error ? err.message : String(err) },
        "background runFlow on resume failed",
      ),
    ),
  );
}

// Stable comparison so retries with the same payload are idempotent.
// Different key order with the same fields hashes differently — clients
// retrying should send the same byte stream.
function payloadsEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
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

type PermissionClaim =
  | { kind: "claimed" }
  | { kind: "already-delivered" }
  | { kind: "noop-idempotent" };

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

  // Phase 1: claim the row with a row-level lock. Two semantics co-exist:
  //   1. unclaimed → CAS the response with our optionId
  //   2. claimed with same optionId → idempotent retry; no UPDATE needed
  //   3. claimed with a different optionId → 409 conflicting choice
  //   4. respondedAt already set → 409 already delivered
  // Returns a tag describing which branch fired so the caller can
  // distinguish "we own the deferred and must deliver" from
  // "another request already finished — return 200 idempotently".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claim: PermissionClaim = await db.transaction(async (tx: any) => {
    const lockedHitl = await lockHitlRow(tx, hitlRequestId);
    const lockedRunRows = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId));
    const lockedRun = lockedRunRows[0];

    if (!lockedHitl || !lockedRun) {
      throw new MaisterError("PRECONDITION", "row vanished mid-transaction");
    }
    if (TERMINAL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is terminal (${lockedRun.status}); cannot respond`,
      );
    }
    if (lockedHitl.respondedAt) {
      const stored = (lockedHitl.response ?? {}) as { optionId?: string };

      if (stored.optionId === optionId) {
        return { kind: "already-delivered" } as const;
      }
      throw new MaisterError("CONFLICT", "hitl request already delivered");
    }
    const stored = lockedHitl.response as { optionId?: string } | null;

    if (stored && stored.optionId && stored.optionId !== optionId) {
      throw new MaisterError(
        "CONFLICT",
        `permission already claimed with optionId="${stored.optionId}"; refusing to overwrite with "${optionId}"`,
      );
    }
    if (stored && stored.optionId === optionId) {
      return { kind: "noop-idempotent" } as const;
    }

    await tx
      .update(hitlRequests)
      .set({ response: { optionId } })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.response),
        ),
      );

    return { kind: "claimed" } as const;
  });

  if (claim.kind === "already-delivered") {
    log.info(
      {
        runId,
        hitlRequestId,
        kind: "permission",
        phase: "already-delivered",
        latencyMs: Date.now() - startedAt,
      },
      "permission already delivered (idempotent retry)",
    );

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  }

  // Phase 2: deliver to supervisor, then mark respondedAt.
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
        idempotent: claim.kind === "noop-idempotent",
        latencyMs: Date.now() - startedAt,
      },
      "permission delivered",
    );

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  } catch (err) {
    if (isMaisterError(err) && err.code === "HITL_TIMEOUT") {
      // Re-check under FOR UPDATE: a concurrent winner may have already
      // marked respondedAt — in which case the supervisor 404 we just
      // saw is the side-effect of THAT request succeeding, not a real
      // timeout. Returning 200 here is the correct idempotent outcome.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await db.transaction(async (tx: any) => {
        const lockedHitl = await lockHitlRow(tx, hitlRequestId);

        if (lockedHitl?.respondedAt) {
          return { transition: "already-delivered" } as const;
        }
        await tx
          .update(runs)
          .set({ status: "Failed", endedAt: new Date() })
          .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")));
        await tx
          .update(hitlRequests)
          .set({ respondedAt: new Date() })
          .where(eq(hitlRequests.id, hitlRequestId));

        return { transition: "terminal" } as const;
      });

      if (outcome.transition === "already-delivered") {
        log.info(
          {
            runId,
            hitlRequestId,
            kind: "permission",
            phase: "concurrent-winner-200",
            latencyMs: Date.now() - startedAt,
          },
          "supervisor 404 raced a concurrent delivery — treating as success",
        );

        return NextResponse.json(
          { ok: true, runStatus: "NeedsInput" },
          { status: 200 },
        );
      }

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

type FormClaim =
  | { kind: "claimed"; storedResponse: unknown; runStatus: string }
  | { kind: "already-delivered"; storedResponse: unknown; runStatus: string };

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

  // Phase 0: validate the response BEFORE any state mutation. Returns 422
  // NEEDS_INPUT on failure so retries with a fixed payload are still
  // possible (respondedAt remains null because the claim never ran).
  assertHitlResponse(response, hitlRow.schema);

  const projectRows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, runRow.projectId));
  const projectSlug = projectRows[0]?.slug;

  if (!projectSlug) {
    throw new MaisterError("PRECONDITION", "project slug not found");
  }

  // Phase 1: claim the row before touching the filesystem. Concurrent
  // double-submits with the same payload are idempotent; conflicting
  // payloads return 409 BEFORE either request can write to disk.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claim: FormClaim = await db.transaction(async (tx: any) => {
    const lockedHitl = await lockHitlRow(tx, hitlRequestId);
    const lockedRunRows = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId));
    const lockedRun = lockedRunRows[0];

    if (!lockedHitl || !lockedRun) {
      throw new MaisterError("PRECONDITION", "row vanished mid-transaction");
    }
    if (TERMINAL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is terminal (${lockedRun.status}); cannot respond`,
      );
    }
    if (lockedHitl.respondedAt) {
      if (payloadsEqual(lockedHitl.response, response)) {
        return {
          kind: "already-delivered",
          storedResponse: lockedHitl.response,
          runStatus: lockedRun.status as string,
        } as const;
      }
      throw new MaisterError("CONFLICT", "hitl request already delivered");
    }
    if (lockedHitl.response !== null && lockedHitl.response !== undefined) {
      if (!payloadsEqual(lockedHitl.response, response)) {
        throw new MaisterError(
          "CONFLICT",
          "hitl request already claimed with a different response payload",
        );
      }
      // same payload — idempotent retry. Fall through to artifact write.
      return {
        kind: "claimed",
        storedResponse: lockedHitl.response,
        runStatus: lockedRun.status as string,
      } as const;
    }

    await tx
      .update(hitlRequests)
      .set({ response })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.response),
        ),
      );

    return {
      kind: "claimed",
      storedResponse: response,
      runStatus: lockedRun.status as string,
    } as const;
  });

  if (claim.kind === "already-delivered") {
    // Same-payload retry on an already-delivered row. If the run is
    // still in NeedsInput, the original microtask may have been lost
    // (process restart between commit and queueMicrotask, runner
    // crash, etc.) — re-queue the wake here so the retry is the
    // durable recovery path. Idempotent: runFlow's resume gate is a
    // no-op if the run has already advanced.
    const needsRequeue = claim.runStatus === "NeedsInput";

    if (needsRequeue) {
      scheduleResume(runId);
    }
    log.info(
      {
        runId,
        hitlRequestId,
        kind: hitlRow.kind,
        phase: "already-delivered",
        requeuedResume: needsRequeue,
        latencyMs: Date.now() - startedAt,
      },
      "form/human already delivered (idempotent retry)",
    );

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  }

  // Phase 2: write the artifact from the STORED response value. Even on
  // an idempotent retry we re-write so that disk and DB stay consistent
  // when an earlier attempt crashed between the claim and the write.
  const inputPath = path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "runs",
    runId,
    `input-${hitlRow.stepId}.json`,
  );

  try {
    await atomicWriteJson(inputPath, claim.storedResponse);
  } catch (err) {
    // respondedAt is still null — leave the row claimed and retryable.
    // The user's intent is durably stored in the DB; the runner's
    // resume-from-existing-input branch will read it on the next try.
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

  // Phase 3: mark the response delivered. The runner is the single
  // owner of the NeedsInput → Running transition (see runFlow's
  // isResume detection); flipping status here would defeat the
  // resume gate and restart the flow at step 0.
  await db
    .update(hitlRequests)
    .set({ respondedAt: new Date() })
    .where(
      and(
        eq(hitlRequests.id, hitlRequestId),
        isNull(hitlRequests.respondedAt),
      ),
    );

  scheduleResume(runId);

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

