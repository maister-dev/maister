import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { canAgentReachProject } from "@/lib/agents/cross-project-reach";
import { httpStatusForAuthz, requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  addTaskRelation,
  getTaskRelations,
  removeTaskRelation,
} from "@/lib/social/relations";
import {
  resolveProjectTaskByNumber,
  resolveTaskByKeyRef,
} from "@/lib/social/task-lookup";
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

// Mirrors the web route. `toNumber` is body-controlled but resolved STRICTLY
// within the URL-param project via (project_id, number) — it cannot reach
// another project. `toTaskKey` (ADR-155) deliberately can, and is gated below.
//
// This schema is shared by POST and DELETE, so the previously missing
// `requires` kind meant an orchestrator-minted `requires` edge was visible
// through relation_list but UNREMOVABLE over ext/MCP. `requires` is
// success-gated — it does NOT release on `Abandoned`/`Failed` — so a wrong
// edge blocks its dependent until someone removes it.
const opBodySchema = z
  .object({
    kind: z.enum([
      "blocks",
      "depends_on",
      "parent_of",
      "requires",
      "duplicate_of",
    ]),
    toNumber: z.number().int().min(1).optional(),
    toTaskKey: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (b) => (b.toNumber === undefined) !== (b.toTaskKey === undefined),
    "provide exactly one of toNumber or toTaskKey",
  );

// ADR-155 D3: `toTaskKey` may land in another project, so the target end needs
// its own authorization. A PROJECT-BOUND token holds no authority outside its
// project and is refused; a NULL-project user token is RBAC re-checked on the
// resolved target.
//
// For a HUMAN operator the refusal is 403, deliberately NOT the existence-hidden
// 404 this surface uses for URL-project scoping: the caller supplied a
// platform-unique key it already holds, so hiding existence leaks nothing and
// only makes the refusal unactionable. Agent tokens are the exception — see the
// enumeration-oracle note below.
type CrossProjectCtx = {
  projectId: string;
  actor: {
    tokenId: string;
    actorLabel: string;
    projectId: string | null;
    tokenKind: string;
    ownerUserId: string | null;
    agentId: string | null;
    boundRunId: string | null;
  };
};

async function refuseCrossProjectTarget(
  ctx: CrossProjectCtx,
  targetProjectId: string,
  audit: { scopeUsed: string; endpoint: string; method: string; db: unknown },
): Promise<NextResponse | null> {
  if (targetProjectId === ctx.projectId) return null;

  // The generic handler audits with the URL project (it cannot know the
  // target), so the refusal writes its own row naming the project actually
  // reached for. Both rows are wanted: one says which scope was exercised
  // where, the other says what was attempted.
  const auditRefusal = (statusCode: number) =>
    recordRequiredTokenAudit(
      {
        tokenId: ctx.actor.tokenId,
        projectId: targetProjectId,
        actorLabel: ctx.actor.actorLabel,
        scopeUsed: audit.scopeUsed,
        endpoint: audit.endpoint,
        method: audit.method,
        result: "error",
        statusCode,
      },
      audit.db,
    );

  // ADR-156: an agent crosses projects through the reach grant, and
  // `relations:create`/`relations:delete` are BOTH in
  // `CROSS_PROJECT_AGENT_SCOPES` — so a granted agent must be allowed through
  // here. An earlier revision returned an unconditional 404 for every agent
  // token, which hid the enumeration oracle but also made the granted path
  // unreachable: the feature the subset exists to enable could never fire.
  //
  // Every DENIAL stays the existence-hidden 404 the oracle argument requires:
  // indistinguishable from the 404 an unresolvable key returns, so an agent
  // still cannot probe for project existence. Only the ALLOW branch differs.
  if (ctx.actor.tokenKind === "agent") {
    const decision = ctx.actor.agentId
      ? await canAgentReachProject({
          agentId: ctx.actor.agentId,
          targetProjectId,
          // The operation's own scope, so `relations:create` and
          // `relations:delete` are checked independently rather than as one
          // blanket "relations" capability.
          scopeLabel: audit.scopeUsed,
          callingRunId: ctx.actor.boundRunId,
          db: audit.db,
        })
      : ({ allowed: false, reason: "no_link" } as const);

    if (decision.allowed) return null;

    await auditRefusal(404);

    return NextResponse.json(
      { code: "NOT_FOUND", message: "relation target task not found" },
      { status: 404 },
    );
  }

  if (ctx.actor.projectId !== null) {
    await auditRefusal(403);

    return NextResponse.json(
      {
        code: "UNAUTHORIZED",
        message:
          "this token is bound to a single project and cannot relate to a task in another project",
      },
      { status: 403 },
    );
  }

  if (ctx.actor.tokenKind === "user" && ctx.actor.ownerUserId !== null) {
    try {
      await requireProjectActionForUser(
        ctx.actor.ownerUserId,
        targetProjectId,
        "manageTaskRelations",
      );
    } catch (err) {
      if (!isMaisterError(err)) throw err;

      // `handleExt` catches only TokenAuthError, so an authz throw escaping
      // here would surface as an unaudited 500.
      const status =
        httpStatusForAuthz(err.code) ?? httpStatusForExtCode(err.code);

      await auditRefusal(status);

      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }

    return null;
  }

  await auditRefusal(403);

  return NextResponse.json(
    { code: "UNAUTHORIZED", message: "cross-project relation not permitted" },
    { status: 403 },
  );
}

// ADR-155 + ADR-156: a relation may cross projects, so this GET can surface a
// FOREIGN task's title and status to a caller authorized only on the URL
// project. The edge itself must stay visible — ADR-155 makes the `blocked`
// chip's `KEY-N` the ONLY mitigation for a wedged `requires` edge, so hiding
// the row would break a stated contract. The CONTENT is what needs gating.
//
// So an unauthorized foreign counterpart keeps its address (`taskKey`,
// `number`) and loses its content (`title`, `status` → null) behind an explicit
// `redacted` flag — a structured signal the consumer can branch on, never an
// in-band placeholder string.
//
// Decisions are memoized per project: a task with N relations into the same
// sibling must not cost N authorization round-trips.
function makeCounterpartAuthorizer(
  ctx: CrossProjectCtx,
  db: unknown,
): (projectId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();

  return (projectId: string) => {
    if (projectId === ctx.projectId) return Promise.resolve(true);

    const hit = cache.get(projectId);

    if (hit) return hit;

    const decide = (async (): Promise<boolean> => {
      if (ctx.actor.tokenKind === "agent") {
        if (!ctx.actor.agentId) return false;

        const decision = await canAgentReachProject({
          agentId: ctx.actor.agentId,
          targetProjectId: projectId,
          scopeLabel: "relations:read",
          callingRunId: ctx.actor.boundRunId,
          db,
        });

        return decision.allowed;
      }

      // A project-bound user/project token holds no authority outside its own
      // project, so a foreign counterpart is always redacted for it.
      if (ctx.actor.projectId !== null) return false;

      if (ctx.actor.tokenKind === "user" && ctx.actor.ownerUserId) {
        try {
          await requireProjectActionForUser(
            ctx.actor.ownerUserId,
            projectId,
            "readBoard",
          );

          return true;
        } catch {
          return false;
        }
      }

      return false;
    })();

    cache.set(projectId, decide);

    return decide;
  };
}

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
      const mayRead = makeCounterpartAuthorizer(ctx, db);
      // ExtRelationView: `role` says which end the URL task is.
      const relations = await Promise.all(
        rows.map(async (row) => {
          const visible = await mayRead(row.other.projectId);

          return {
            kind: row.kind,
            role: row.direction === "out" ? "from" : "to",
            other: {
              taskId: row.other.taskId,
              number: row.other.number,
              taskKey: row.other.key,
              title: visible ? row.other.title : null,
              status: visible ? row.other.status : null,
              redacted: !visible,
            },
          };
        }),
      );

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

      // The archived check is scoped to the toTaskKey arm: `toNumber` resolves
      // inside the URL project, whose archived state this route has never
      // gated, and widening that here would break existing callers.
      const to =
        body.toTaskKey === undefined
          ? await resolveProjectTaskByNumber(slug, body.toNumber!, db)
          : await resolveTaskByKeyRef(body.toTaskKey, db);

      if (!to || (body.toTaskKey !== undefined && to.project.archivedAt)) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "relation target task not found" },
          { status: 404 },
        );
      }

      const refusal = await refuseCrossProjectTarget(ctx, to.project.id, {
        scopeUsed: scopeLabel,
        endpoint,
        method,
        db,
      });

      if (refusal) return refusal;

      const actor = socialActorForToken(ctx.actor);
      // ADR-156: an agent token that reached this project through the
      // cross-project grant (its own project differs from the one it is acting
      // in) may only delete edges it authored itself — the grant is justified
      // by "remove the edge it created", not by authority over the project's
      // whole relation graph. Same-project agent tokens and user tokens are
      // untouched: they already hold `manageTaskRelations` here.
      const reachAgentId =
        ctx.actor.tokenKind === "agent" &&
        ctx.actor.agentId !== null &&
        ctx.actor.projectId !== null &&
        ctx.actor.projectId !== ctx.projectId
          ? ctx.actor.agentId
          : null;
      const input = {
        projectId: ctx.projectId,
        fromTaskId: taskId,
        kind: body.kind,
        toTaskId: to.task.id,
        actor,
        ...(mode === "remove" && reachAgentId !== null
          ? {
              onlyAuthoredBy: {
                actorType: "agent" as const,
                actorId: reachAgentId,
              },
            }
          : {}),
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
