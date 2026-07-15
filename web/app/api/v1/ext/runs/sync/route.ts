import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { syncRunTarget, type SyncActor } from "@/lib/runs/sync-target";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/sync";
const SCOPE = "runs:sync";

const bodySchema = z
  .object({
    runId: z.string().min(1),
    strategy: z.enum(["rebase", "merge"]).optional(),
    agent: z.boolean().optional(),
    push: z.boolean().optional(),
    runnerId: z.string().min(1).max(255).optional(),
  })
  .strict();

type SyncBody = z.infer<typeof bodySchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb() as Db;

  // Parse+validate the body once, up front, so `resolveProjectId` can key on
  // `runId` (a body field, not a path segment). The stream is consumed here and
  // reused inside `work` — never re-read.
  let body: SyncBody;

  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { code: "CONFIG", message: `invalid body: ${(err as Error).message}` },
      { status: 422 },
    );
  }

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "POST",
      requireScope: true,
      // Server-derive projectId from the run row; cross-project mismatch is
      // existence-hidden as 404 by handleExt. projectId is NEVER a body field.
      resolveProjectId: async ({ db }) => {
        const rows = await db
          .select({ projectId: runs.projectId })
          .from(runs)
          .where(eq(runs.id, body.runId));

        return rows[0]?.projectId ?? null;
      },
      db,
    },
    async (ctx) => {
      // Existence-hide within the token's project (belt-and-suspenders: handleExt
      // already enforced ownership via resolveProjectId + mismatch → 404).
      const rows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, body.runId), eq(runs.projectId, ctx.projectId)));

      if (rows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      if (body.runnerId) {
        const catalog = await loadRunnerCatalog(db);

        if (!catalog.some((entry) => entry.id === body.runnerId)) {
          return NextResponse.json(
            { code: "CONFIG", message: `unknown runnerId: ${body.runnerId}` },
            { status: 422 },
          );
        }
      }

      const actor: SyncActor = ctx.actor.agentId
        ? { type: "agent", id: ctx.actor.agentId }
        : { type: "user", id: ctx.actor.ownerUserId };

      try {
        const result = await syncRunTarget({
          runId: body.runId,
          strategy: body.strategy,
          agent: body.agent,
          push: body.push,
          runnerId: body.runnerId,
          actor,
          db,
        });

        return NextResponse.json(
          {
            runId: body.runId,
            attemptId: result.attemptId,
            outcome: result.outcome,
            behind: result.behind,
            pushed: result.pushed,
          },
          { status: result.outcome === "agent_launched" ? 202 : 200 },
        );
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }
    },
  );
}
