import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  addTaskRelation,
  getTaskRelations,
  removeTaskRelation,
} from "@/lib/social/relations";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { tasks } = schemaModule as unknown as Record<string, any>;

const ENDPOINT_RELATIONS_GET =
  "GET /api/v1/ext/projects/[slug]/tasks/[taskId]/relations";
const ENDPOINT_RELATIONS_POST =
  "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/relations";
const ENDPOINT_RELATIONS_DELETE =
  "DELETE /api/v1/ext/projects/[slug]/tasks/[taskId]/relations";

// Mirrors the web route: `toNumber` is body-controlled but resolved STRICTLY
// within the URL-param project via (project_id, number) — cross-project reach
// is impossible by construction (ADR-078).
const opBodySchema = z
  .object({
    kind: z.enum(["blocks", "depends_on", "parent_of"]),
    toNumber: z.number().int().min(1),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };
type TransactionalDb = {
  transaction<T>(scope: (tx: unknown) => Promise<T>): Promise<T>;
};

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
      scopeLabel: "relations:read",
      endpoint: ENDPOINT_RELATIONS_GET,
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

      const rows = await getTaskRelations(taskId, db);
      // ExtRelationView: `role` says which end the URL task is.
      const relations = rows.map((row) => ({
        kind: row.kind,
        role: row.direction === "out" ? "from" : "to",
        other: {
          taskId: row.other.taskId,
          number: row.other.number,
          taskKey: row.other.key,
          title: row.other.title,
          status: row.other.status,
        },
      }));

      return NextResponse.json({ relations }, { status: 200 });
    },
  );
}

type Mode = "add" | "remove";

async function handleMutation(
  req: NextRequest,
  { params }: RouteParams,
  mode: Mode,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();
  const endpoint =
    mode === "add" ? ENDPOINT_RELATIONS_POST : ENDPOINT_RELATIONS_DELETE;
  const scopeLabel = mode === "add" ? "relations:create" : "relations:delete";
  const method = mode === "add" ? "POST" : "DELETE";

  return handleExt(
    req,
    {
      slug,
      scopeLabel,
      endpoint,
      method,
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      let body: z.infer<typeof opBodySchema>;

      try {
        body = opBodySchema.parse(await req.json());
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

      const to = await resolveProjectTaskByNumber(slug, body.toNumber, db);

      if (!to) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "relation target task not found" },
          { status: 404 },
        );
      }

      const actor = socialActorForToken(ctx.actor);
      const input = {
        projectId: ctx.projectId,
        fromTaskId: taskId,
        kind: body.kind,
        toTaskId: to.task.id,
        actor,
      };

      try {
        const result = await (db as TransactionalDb).transaction(async (tx) => {
          const outcome =
            mode === "add"
              ? await addTaskRelation(input, tx)
              : await removeTaskRelation(input, tx);

          await recordRequiredTokenAudit(
            {
              tokenId: ctx.actor.tokenId,
              projectId: ctx.projectId,
              actorLabel: ctx.actor.actorLabel,
              scopeUsed: scopeLabel,
              endpoint,
              method,
              result: "ok",
              statusCode: mode === "add" ? 201 : 200,
            },
            tx,
          );

          return outcome;
        });

        if (mode === "add") {
          return NextResponse.json(
            { ok: true, created: (result as { created: boolean }).created },
            { status: 201 },
          );
        }

        return NextResponse.json(
          { ok: true, removed: (result as { removed: boolean }).removed },
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

export async function POST(
  req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleMutation(req, ctx, "add");
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteParams,
): Promise<NextResponse> {
  return handleMutation(req, ctx, "remove");
}
