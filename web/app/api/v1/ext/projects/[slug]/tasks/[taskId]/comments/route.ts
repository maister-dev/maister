import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  addTaskComment,
  listTaskComments,
  toCommentDTOs,
} from "@/lib/social/comments";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { actorUserIdForToken } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { tasks } = schemaModule as unknown as Record<string, any>;

const ENDPOINT_COMMENTS_GET =
  "GET /api/v1/ext/projects/[slug]/tasks/[taskId]/comments";
const ENDPOINT_COMMENTS_POST =
  "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/comments";

const postBodySchema = z
  .object({
    body: z.string().min(1).max(10_000),
  })
  .strict();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };
type TransactionalDb = {
  transaction<T>(scope: (tx: unknown) => Promise<T>): Promise<T>;
};

// `taskId` ownership is re-validated against the token's project (existing
// ext idiom — cross-project access hides existence with 404).
async function taskInProject(
  db: unknown,
  taskId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await (db as { select: any })
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  return rows.length > 0;
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "comments:read",
      endpoint: ENDPOINT_COMMENTS_GET,
      method: "GET",
      db,
    },
    async (ctx) => {
      if (!(await taskInProject(db, taskId, ctx.projectId))) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      const query = listQuerySchema.safeParse(
        Object.fromEntries(req.nextUrl.searchParams),
      );

      if (!query.success) {
        return NextResponse.json(
          { code: "CONFIG", message: "invalid limit/offset query" },
          { status: 422 },
        );
      }

      const rows = await listTaskComments(taskId, query.data, db);
      const comments = await toCommentDTOs(rows, db);

      return NextResponse.json({ comments }, { status: 200 });
    },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "comments:create",
      endpoint: ENDPOINT_COMMENTS_POST,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      let body: z.infer<typeof postBodySchema>;

      try {
        body = postBodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      if (!(await taskInProject(db, taskId, ctx.projectId))) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      // Actor mapping (ADR-078 D12): a user-owned token acts as that user; an
      // ownerless project token acts as system with the token recorded in the
      // comment-activity payload.
      const ownerUserId = actorUserIdForToken(ctx.actor);
      const actor = ownerUserId
        ? ({ type: "user", id: ownerUserId } as const)
        : ({ type: "system", id: null } as const);

      try {
        const record = await (db as TransactionalDb).transaction(
          async (tx) => {
            const comment = await addTaskComment(
              {
                taskId,
                body: body.body,
                actor,
                ...(actor.type === "system"
                  ? {
                      activityPayloadExtra: {
                        via: "ext",
                        tokenId: ctx.actor.tokenId,
                      },
                    }
                  : {}),
              },
              tx,
            );

            await recordRequiredTokenAudit(
              {
                tokenId: ctx.actor.tokenId,
                projectId: ctx.actor.projectId,
                actorLabel: ctx.actor.actorLabel,
                scopeUsed: "comments:create",
                endpoint: ENDPOINT_COMMENTS_POST,
                method: "POST",
                result: "ok",
                statusCode: 201,
              },
              tx,
            );

            return comment;
          },
        );
        const [comment] = await toCommentDTOs([record], db);

        return NextResponse.json({ comment }, { status: 201 });
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
