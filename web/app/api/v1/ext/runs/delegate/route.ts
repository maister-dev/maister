import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { launchAgentRun } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { orchestratorMaxDepth } from "@/lib/instance-config";
import { addTaskRelation } from "@/lib/social/relations";
import { createTask } from "@/lib/services/tasks";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs, tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "ext-runs-delegate",
  level: process.env.LOG_LEVEL ?? "info",
});

const ENDPOINT = "POST /api/v1/ext/runs/delegate";

const bodySchema = z
  .object({
    target: z
      .object({
        agentId: z.string().min(1).optional(),
        flowId: z.string().min(1).optional(),
      })
      .strict(),
    mode: z.enum(["task", "run"]),
    prompt: z.string().min(1),
    title: z.string().min(1).optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]).optional(),
    // M37 Phase 10 (ADR-099): `own` (default) = per-run worktree; `shared` = N
    // children of this orchestrator tree share one pre-allocated tree (serialized
    // writers via the promote-time guard). Only meaningful for workspace=worktree.
    workspaceMode: z.enum(["own", "shared"]).optional(),
    runnerOverride: z.string().min(1).optional(),
    // M37 Phase 8 (ADR-099): a persistent child parks between turns and is
    // re-addressable by `addressableKey`; the key is REQUIRED when persistent.
    persistent: z.boolean().optional(),
    addressableKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
  })
  .strict()
  .refine((b) => !b.persistent || b.addressableKey !== undefined, {
    message: "addressableKey is required when persistent is true",
    path: ["addressableKey"],
  });

type DelegateBody = z.infer<typeof bodySchema>;

// Walk the parent_run_id chain up from `startId`, counting hops. The parent run
// itself is depth 0; each ancestor adds 1. The FK guarantees a DAG so the walk
// terminates; the loop cap is a defensive backstop against any cycle a manual
// DB edit could introduce.
async function delegationDepth(db: Db, startId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = startId;
  const cap = 64;

  while (currentId && depth < cap) {
    const rows = (await db
      .select({ parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, currentId))) as { parentRunId: string | null }[];
    const parentRunId: string | null = rows[0]?.parentRunId ?? null;

    if (!parentRunId) break;
    depth += 1;
    currentId = parentRunId;
  }

  return depth;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: "runs:delegate",
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      let body: DelegateBody;

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

      // The PARENT runId is the token's run binding — NEVER a body field. A
      // token with no run binding cannot delegate (per the trust table).
      const parentRunId = ctx.actor.boundRunId;

      if (!parentRunId) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "delegation requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // Flow-target delegation is out of scope for Phase 3.
      if (body.target.flowId) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: "flow-target delegation is not yet supported",
          },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      if (!body.target.agentId) {
        return NextResponse.json(
          { code: "CONFIG", message: "target.agentId is required" },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      const agentId = body.target.agentId;

      // Load the parent run scoped to the token's project — a missing/foreign
      // parent is an unconfigured delegation surface.
      const parentRows = await db
        .select({
          id: runs.id,
          taskId: runs.taskId,
          rootRunId: runs.rootRunId,
        })
        .from(runs)
        .where(
          and(eq(runs.id, parentRunId), eq(runs.projectId, ctx.projectId)),
        );
      const parent = parentRows[0];

      if (!parent) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "bound parent run not found in project",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      const rootRunId = parent.rootRunId ?? parent.id;

      // Depth bound: refuse if the parent chain is already at the limit.
      const depth = await delegationDepth(db, parent.id);

      if (depth >= orchestratorMaxDepth()) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `delegation depth limit reached (${orchestratorMaxDepth()})`,
          },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      let childTaskId: string | undefined;

      try {
        if (body.mode === "task") {
          // Reuse the orchestrator's task flow as the child's default; a
          // flowless child is a simple-intent task awaiting triage.
          let parentFlowId: string | null = null;

          if (parent.taskId) {
            const orchTaskRows = await db
              .select({ flowId: tasks.flowId })
              .from(tasks)
              .where(eq(tasks.id, parent.taskId));

            parentFlowId = orchTaskRows[0]?.flowId ?? null;
          }

          const created = await createTask(
            {
              title: body.title ?? titleFromPrompt(body.prompt),
              prompt: body.prompt,
              flowId: parentFlowId,
            },
            { projectId: ctx.projectId, actorUserId: null },
            db,
          );

          childTaskId = created.taskId;

          // parent_of from the orchestrator's task to the child. If the
          // orchestrator run has no task, the child task still exists but there
          // is no board parent to link it under — log and continue.
          if (parent.taskId) {
            await addTaskRelation(
              {
                projectId: ctx.projectId,
                fromTaskId: parent.taskId,
                kind: "parent_of",
                toTaskId: childTaskId,
                actor: socialActorForToken(ctx.actor),
              },
              db,
            );
          } else {
            log.info(
              { parentRunId, childTaskId },
              "delegation parent run has no task — child task created without a parent_of relation",
            );
          }
        }

        const result = await launchAgentRun({
          agentId,
          projectId: ctx.projectId,
          taskId: childTaskId ?? null,
          launchOverrideRunnerId: body.runnerOverride ?? null,
          parentRunId,
          rootRunId,
          launchMode: "manual",
          persistent: body.persistent ?? false,
          addressableKey: body.addressableKey ?? null,
          workspaceMode: body.workspaceMode ?? null,
          // M37 (ADR-100): honor the requested per-child workspace axis (was
          // previously parsed then dropped).
          workspace: body.workspace ?? null,
          trigger: { source: "manual" },
          db,
        });

        if ("deduped" in result) {
          // No trigger event id is set on a delegation, so this is unreachable
          // in practice — treat it as a precondition failure rather than
          // silently returning a phantom child.
          throw new MaisterError(
            "PRECONDITION",
            "delegated launch was unexpectedly deduped",
          );
        }

        await recordRequiredTokenAudit(
          {
            tokenId: ctx.actor.tokenId,
            projectId: ctx.actor.projectId,
            actorLabel: ctx.actor.actorLabel,
            scopeUsed: "runs:delegate",
            endpoint: ENDPOINT,
            method: "POST",
            result: "ok",
            statusCode: 202,
          },
          db,
        );

        return NextResponse.json(
          {
            childRunId: result.runId,
            ...(childTaskId ? { childTaskId } : {}),
          },
          { status: 202 },
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
