import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { socialActorForToken } from "@/lib/tokens/verify";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { reopenRun, type ReopenActor } from "@/lib/runs/reopen";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/reopen";
const SCOPE = "runs:sync";

const bodySchema = z
  .object({
    runId: z.string().min(1),
  })
  .strict();

type ReopenBody = z.infer<typeof bodySchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb() as Db;

  let body: ReopenBody;

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
      // Canonical mapper — see the note in the sibling sync route: a hand-rolled
      // mapping records an ownerless PROJECT token as `{user, id: null}` rather
      // than `{system, null}`, corrupting the lifecycle-op audit trail.
      const actor: ReopenActor = socialActorForToken(ctx.actor);

      try {
        const result = await reopenRun({ runId: body.runId, actor, db });

        return NextResponse.json(
          { runId: body.runId, status: result.status },
          { status: 200 },
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
