import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import { socialActorForToken } from "@/lib/tokens/verify";
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

  // AUTH FIRST — exactly like every sibling run-action route (promote, cancel,
  // rework, …): the token is verified, scoped, and AUDITED before this request's
  // body is ever touched. Keying `resolveProjectId` off a body field forced the
  // parse above `handleExt`, so a valid token sending a malformed body was
  // answered 422 with NO `token_audit_log` row — handleExt is that table's sole
  // writer. The project comes from the TOKEN; the run is then existence-hidden
  // against it below, which is the same boundary resolveProjectId was drawing.
  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "POST",
      requireScope: true,
      db,
    },
    async (ctx) => {
      let body: SyncBody;

      try {
        body = bodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      // Existence-hide within the token's project: a run in ANOTHER project is
      // indistinguishable from one that does not exist. projectId is NEVER a
      // body field.
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

      // Use the CANONICAL mapper (every other polymorphic-actor ext route does).
      // A hand-rolled `agentId ? agent : user` mislabels an ownerless PROJECT
      // token — the default project-token shape — as `{user, id: null}`, so the
      // force-push ledger would claim a human did it and name nobody. The
      // canonical mapper resolves that case to `{system, null}`.
      const actor: SyncActor = socialActorForToken(ctx.actor);

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
