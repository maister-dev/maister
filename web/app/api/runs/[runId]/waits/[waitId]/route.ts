import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { privateJson } from "@/lib/api/private-json";
import { projectRolesForActions } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runWaitDeliveries } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { waitHttpError } from "@/lib/waits/http";
import { allowedWaitActions } from "@/lib/waits/operator";
import { readWaitForSession } from "@/lib/waits/session";
import { signalWaitOutcomes } from "@/lib/waits/store";

const endpoint = "/api/runs/{runId}/waits/{waitId}";
const pageSize = 20;
const pageCursor = z.tuple([
  z.iso.datetime(),
  z.string().regex(/^[a-f0-9]{64}$/),
]);

function readCursor(request: Request): z.infer<typeof pageCursor> | null {
  const values = new URL(request.url).searchParams.getAll("cursor");

  if (!values.length) return null;
  if (values.length === 1 && /^[A-Za-z0-9_-]{1,512}$/.test(values[0])) {
    try {
      const parsed = pageCursor.safeParse(
        JSON.parse(Buffer.from(values[0], "base64url").toString("utf8")),
      );

      if (parsed.success) return parsed.data;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  throw new MaisterError("CONFIG", "Invalid wait delivery cursor");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; waitId: string }> },
) {
  try {
    const { runId, waitId } = await context.params;
    const { access, wait } = await readWaitForSession(runId, waitId);
    const cursor = readCursor(request);
    const deliveries = await getDb()
      .select({
        id: runWaitDeliveries.id,
        status: runWaitDeliveries.disposition,
        receivedAt: sql<string>`to_char(${runWaitDeliveries.receivedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(runWaitDeliveries)
      .where(
        and(
          eq(runWaitDeliveries.waitId, wait.id),
          cursor
            ? sql`(${runWaitDeliveries.receivedAt},${runWaitDeliveries.id}) < (${cursor[0]}::timestamptz,${cursor[1]})`
            : undefined,
        ),
      )
      .orderBy(desc(runWaitDeliveries.receivedAt), desc(runWaitDeliveries.id))
      .limit(pageSize + 1);
    const last = deliveries.length > pageSize ? deliveries[pageSize - 1] : null;
    const canOperate = projectRolesForActions(["operateWait"]).includes(
      access.role,
    );
    const canReadData = projectRolesForActions(["readRepoFiles"]).includes(
      access.role,
    );
    const label = wait.condition.parameters.name;
    const result = wait.result;

    const allowedActions = canOperate
      ? allowedWaitActions(wait, new Date())
      : [];

    return privateJson({
      id: wait.id,
      status: wait.state,
      version: wait.version,
      condition: {
        kind: wait.conditionKind,
        ...(typeof label === "string" ? { label } : {}),
      },
      deadline: wait.deadlineAt?.toISOString() ?? null,
      ...(wait.nextDueAt ? { dueAt: wait.nextDueAt.toISOString() } : {}),
      allowedActions,
      allowedOutcomes: allowedActions.includes("resolve_now")
        ? wait.condition.outcomes
        : [],
      allowedSignalOutcomes: allowedActions.includes("deliver_signal")
        ? signalWaitOutcomes(wait)
        : [],
      ...(result
        ? {
            result: {
              outcome: result.outcome,
              source: result.source,
              redacted: !canReadData && result.data !== undefined,
              ...(canReadData && result.data !== undefined
                ? { data: result.data }
                : {}),
            },
          }
        : {}),
      deliveries: deliveries.slice(0, pageSize),
      nextCursor: last
        ? Buffer.from(JSON.stringify([last.receivedAt, last.id])).toString(
            "base64url",
          )
        : null,
    });
  } catch (error: unknown) {
    return waitHttpError(error, endpoint);
  }
}
