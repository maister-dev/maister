import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { launchAgentRun } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  orchestratorMaxDepth,
  orchestratorMaxFanout,
} from "@/lib/instance-config";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
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
  name: "ext-runs-plan",
  level: process.env.LOG_LEVEL ?? "info",
});

const ENDPOINT = "POST /api/v1/ext/runs/plan";

const planTaskSchema = z
  .object({
    key: z.string().min(1),
    target: z
      .object({
        agentId: z.string().min(1),
      })
      .strict(),
    prompt: z.string().min(1),
    title: z.string().min(1).optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]).optional(),
    runnerOverride: z.string().min(1).optional(),
    dependsOn: z.array(z.string().min(1)),
  })
  .strict();

const bodySchema = z
  .object({
    tasks: z.array(planTaskSchema),
  })
  .strict();

type PlanBody = z.infer<typeof bodySchema>;
type PlanTask = z.infer<typeof planTaskSchema>;

// Walk the parent_run_id chain up from `startId`, counting hops (matches
// delegate/route.ts). The parent run itself is depth 0; each ancestor adds 1.
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

// Kahn topological reduction: peel keys with no remaining unresolved
// dependency until none are left. A non-empty residue ⇒ a cycle. Every
// `dependsOn` key is pre-validated to be an in-batch key, so the only failure
// this surfaces is a true cycle.
function hasCycle(planTasks: PlanTask[]): boolean {
  const remaining = new Map<string, Set<string>>(
    planTasks.map((t) => [t.key, new Set(t.dependsOn)]),
  );

  let progressed = true;

  while (progressed && remaining.size > 0) {
    progressed = false;

    for (const [key, deps] of remaining) {
      if (deps.size === 0) {
        remaining.delete(key);
        for (const other of remaining.values()) other.delete(key);
        progressed = true;
      }
    }
  }

  return remaining.size > 0;
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
      let body: PlanBody;

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
      // token with no run binding cannot emit a plan (per the trust table).
      const parentRunId = ctx.actor.boundRunId;

      if (!parentRunId) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "run_plan requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // Finding 1 (Codex adversarial review): fail closed if the bound
      // orchestrator has terminalized — a stale run-bound token must not write a
      // new task-DAG under a terminal tree.
      const boundRes = await resolveActiveBoundRun(
        db,
        parentRunId,
        ctx.projectId,
      );

      if (!boundRes.ok) {
        return NextResponse.json(
          { code: boundRes.code, message: boundRes.message },
          { status: httpStatusForExtCode(boundRes.code) },
        );
      }

      const planTasks = body.tasks;

      // --- Pre-tx validation (NO rows written on any failure) ---

      // (a) non-empty + fan-out bound.
      if (planTasks.length === 0) {
        return NextResponse.json(
          { code: "CONFIG", message: "tasks must be non-empty" },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      if (planTasks.length > orchestratorMaxFanout()) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `plan fan-out limit reached (${orchestratorMaxFanout()})`,
          },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      // (b) keys unique + every dependsOn references an in-batch key.
      const keys = new Set<string>();

      for (const t of planTasks) {
        if (keys.has(t.key)) {
          return NextResponse.json(
            { code: "CONFIG", message: `duplicate task key "${t.key}"` },
            { status: httpStatusForExtCode("CONFIG") },
          );
        }
        keys.add(t.key);
      }

      for (const t of planTasks) {
        for (const dep of t.dependsOn) {
          if (dep === t.key) {
            return NextResponse.json(
              {
                code: "CONFIG",
                message: `task "${t.key}" cannot depend on itself`,
              },
              { status: httpStatusForExtCode("CONFIG") },
            );
          }

          if (!keys.has(dep)) {
            return NextResponse.json(
              {
                code: "CONFIG",
                message: `task "${t.key}" dependsOn unknown key "${dep}"`,
              },
              { status: httpStatusForExtCode("CONFIG") },
            );
          }
        }
      }

      // (c) the dependsOn graph must be acyclic.
      if (hasCycle(planTasks)) {
        return NextResponse.json(
          { code: "CONFIG", message: "task dependency graph has a cycle" },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      // Load the parent (orchestrator) run scoped to the token's project.
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

      // (d) run-tree depth: the child tasks launch one level below the parent.
      const depth = await delegationDepth(db, parent.id);

      if (depth + 1 >= orchestratorMaxDepth()) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `delegation depth limit reached (${orchestratorMaxDepth()})`,
          },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      // (e) every target agent must resolve (enablement+trust+pinned revision).
      // Collect ALL failures so the caller sees every bad target at once; NO
      // rows are written on any failure.
      const resolveFailures: string[] = [];

      for (const t of planTasks) {
        try {
          await resolveEffectiveAgentDefinition(
            { agentId: t.target.agentId, projectId: ctx.projectId },
            db,
          );
        } catch (err) {
          resolveFailures.push(
            `${t.key} (${t.target.agentId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      if (resolveFailures.length > 0) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: `unresolvable plan targets: ${resolveFailures.join("; ")}`,
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // --- Create the whole DAG in ONE transaction ---
      let keyToTaskId: Map<string, string>;

      try {
        keyToTaskId = await db.transaction(async (tx: Db) => {
          const map = new Map<string, string>();

          for (const t of planTasks) {
            const created = await createTask(
              {
                title: t.title ?? titleFromPrompt(t.prompt),
                prompt: t.prompt,
                flowId: null,
              },
              { projectId: ctx.projectId, actorUserId: null },
              tx,
            );

            // Stamp the as-plan launch intent — createTask does not accept it.
            await tx
              .update(tasks)
              .set({
                launchMode: "auto",
                delegationSpec: {
                  agentId: t.target.agentId,
                  ...(t.workspace ? { workspace: t.workspace } : {}),
                  ...(t.runnerOverride
                    ? { runnerOverride: t.runnerOverride }
                    : {}),
                },
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, created.taskId));

            map.set(t.key, created.taskId);

            // parent_of from the orchestrator's task. A task-less orchestrator
            // run still gets its as-plan tasks created — just no board parent.
            if (parent.taskId) {
              await addTaskRelation(
                {
                  projectId: ctx.projectId,
                  fromTaskId: parent.taskId,
                  kind: "parent_of",
                  toTaskId: created.taskId,
                  actor: socialActorForToken(ctx.actor),
                },
                tx,
              );
            }
          }

          if (!parent.taskId) {
            log.info(
              { parentRunId },
              "run_plan parent run has no task — as-plan tasks created without parent_of relations",
            );
          }

          // requires edges: (task K dependsOn D) ⇒ (K requires D), success-gated.
          for (const t of planTasks) {
            for (const dep of t.dependsOn) {
              await addTaskRelation(
                {
                  projectId: ctx.projectId,
                  fromTaskId: map.get(t.key)!,
                  kind: "requires",
                  toTaskId: map.get(dep)!,
                  actor: socialActorForToken(ctx.actor),
                },
                tx,
              );
            }
          }

          return map;
        });
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }

      // --- After commit: launch the SOURCE tasks (empty dependsOn) ---
      // A source-launch failure must NOT roll back the committed DAG — the
      // task stays Backlog and the auto-launcher (or a retry) picks it up.
      const result: Array<{
        key: string;
        taskId: string;
        childRunId?: string;
      }> = [];

      for (const t of planTasks) {
        const childTaskId = keyToTaskId.get(t.key)!;
        const entry: { key: string; taskId: string; childRunId?: string } = {
          key: t.key,
          taskId: childTaskId,
        };

        if (t.dependsOn.length === 0) {
          try {
            const launched = await launchAgentRun({
              agentId: t.target.agentId,
              projectId: ctx.projectId,
              taskId: childTaskId,
              launchOverrideRunnerId: t.runnerOverride ?? null,
              parentRunId,
              rootRunId,
              launchMode: "auto",
              trigger: { source: "manual" },
              db,
            });

            if (!("deduped" in launched)) entry.childRunId = launched.runId;
          } catch (err) {
            log.warn(
              {
                parentRunId,
                key: t.key,
                taskId: childTaskId,
                agentId: t.target.agentId,
                code: isMaisterError(err) ? err.code : "UNKNOWN",
                err: err instanceof Error ? err.message : String(err),
              },
              "run_plan source-task launch failed — task stays Backlog for the auto-launcher",
            );
          }
        }

        result.push(entry);
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

      return NextResponse.json({ tasks: result }, { status: 202 });
    },
  );
}
