import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { launchAgentRun } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  type DelegatableFlow,
  flowDelegationSnapshot,
  resolveDelegatableFlow,
} from "@/lib/flows/delegatable-flow";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { cascadeAbandonRunTreeAndStopSessions } from "@/lib/orchestrator/cascade";
import {
  delegationTargetKind,
  delegationTargetSchema,
  refuseUnsupportedDelegationOption,
  titleFromPrompt,
} from "@/lib/orchestrator/delegation-target";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
import { addTaskRelation } from "@/lib/social/relations";
import { launchRun } from "@/lib/services/runs";
import { abandonUnlaunchedTasks, createTask } from "@/lib/services/tasks";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "ext-runs-delegate",
  level: process.env.LOG_LEVEL ?? "info",
});

const ENDPOINT = "POST /api/v1/ext/runs/delegate";

/**
 * W2 compensation: the carrier transaction committed, then the launch failed.
 *
 * ABANDONS the carrier task — never deletes it. `runs.task_id` and
 * `domain_events.task_id` cascade on delete, so a hard delete could erase a run
 * inserted concurrently and always erased the committed `task.created` fact;
 * the task model's terminal exit everywhere else is `Abandoned`. The `parent_of`
 * relation stays as provenance. The "task has no run" guard lives inside the
 * UPDATE: a launch that failed AFTER inserting the run row (the adopt/CONFLICT
 * paths) keeps a live task, and the run row is the only durable evidence of
 * that. A compensation that throws would replace the caller's real error with a
 * cleanup error and lose the diagnosis — so it logs and returns.
 */
async function compensateChildTask(args: {
  db: Db;
  childTaskId: string | undefined;
  parentRunId: string;
  code: string;
}): Promise<void> {
  const { db, childTaskId } = args;

  if (!childTaskId) return;

  log.warn(
    {
      parentRunId: args.parentRunId,
      carrierTaskId: childTaskId,
      code: args.code,
    },
    "[delegation.compensate] delegation failed after the child task — abandoning it",
  );

  const abandoned = await abandonUnlaunchedTasks(
    db,
    [childTaskId],
    new Date(),
  ).catch((err: unknown) => {
    log.error(
      {
        parentRunId: args.parentRunId,
        carrierTaskId: childTaskId,
        err: err instanceof Error ? err.message : String(err),
      },
      "[delegation.compensate] child task abandon failed (manual cleanup may be required)",
    );

    return [] as string[];
  });

  if (abandoned.length === 0) {
    log.warn(
      { parentRunId: args.parentRunId, carrierTaskId: childTaskId },
      "[delegation.compensate] child task already has a run — left in place",
    );
  }
}

const bodySchema = z
  .object({
    // ADR-163: the wire shape lives in ONE module, imported by both delegation
    // entry points — exactly one of agentId / flowId, each arm strict.
    target: delegationTargetSchema,
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

      // ADR-163: the per-kind option allow-list. A field the target kind cannot
      // support is REFUSED with its own message, never ignored — including
      // `title` on an agent `mode: run`, which used to be silently dropped.
      const targetKind = delegationTargetKind(body.target);
      const optionRefusal = refuseUnsupportedDelegationOption(targetKind, body);

      if (optionRefusal) {
        return NextResponse.json(
          { code: "CONFIG", message: optionRefusal },
          { status: httpStatusForExtCode("CONFIG") },
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

      // Finding 1 (Codex adversarial review): resolve the bound orchestrator
      // scoped to the token's project AND fail closed if it is missing or has
      // terminalized — a stale run-bound token must not delegate under a
      // terminal tree (token revocation is best-effort on the normal exit path).
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

      const parent = boundRes.run;

      const rootRunId = parent.rootRunId ?? parent.id;

      // ADR-163: locate -> establish trust -> execute. Trust resolution runs
      // in a module that cannot start a run, so every refusal here writes ZERO
      // rows — the guarantee is structural, not incidental.
      let resolvedFlow: DelegatableFlow | null = null;

      if (targetKind === "flow") {
        try {
          resolvedFlow = await resolveDelegatableFlow(
            { projectId: ctx.projectId, flowId: body.target.flowId as string },
            db,
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
      }

      // ADR-163 D1: a FLOW target always gets a carrier task — a flow run
      // cannot exist without one, and the board renders a `parent_of` child as
      // its own card either way, so omitting the link would produce the same
      // card with no provenance. `mode` therefore changes nothing for a flow
      // target — presence and linkage are unconditional; it is only recorded
      // in the delegation snapshot.
      const needsChildTask = targetKind === "flow" || body.mode === "task";
      let childTaskId: string | undefined;

      try {
        // ADR-163 D8: admission and the child task share ONE transaction, so
        // the fast-path bound and the reservation cannot be split by a racer.
        // The DECISIVE bound is re-taken inside the launcher's own run-insert
        // transaction under the same lock (see admitDelegatedChild call sites).
        await db.transaction(async (tx: Db) => {
          await admitDelegatedChild(tx, { parentRunId: parent.id });

          if (!needsChildTask) return;

          // The child task's flow: for a FLOW target it is the SELECTED flow,
          // explicitly NOT inherited from the orchestrator's task. For an agent
          // target the orchestrator's flow stays the default (a flowless child
          // is a simple-intent task awaiting triage) — unchanged behavior.
          let childFlowId: string | null = resolvedFlow?.flowId ?? null;

          if (!childFlowId && parent.taskId) {
            const orchTaskRows = await tx
              .select({ flowId: tasks.flowId })
              .from(tasks)
              .where(eq(tasks.id, parent.taskId));

            childFlowId = orchTaskRows[0]?.flowId ?? null;
          }

          const created = await createTask(
            {
              title: body.title ?? titleFromPrompt(body.prompt),
              prompt: body.prompt,
              flowId: childFlowId,
            },
            { projectId: ctx.projectId, actorUserId: null },
            tx,
          );

          childTaskId = created.taskId;

          // Stamp the delegation intent — `createTask` does not accept it
          // (same idiom as run_plan's as-plan tasks). `launch_mode='manual'` is
          // what keeps the as-plan auto-launcher and the abandon cascade's
          // un-launched-task sweep away from a carrier task; `delegation_spec`
          // records WHAT was delegated, so a reader of the board card can see
          // it without walking to the run.
          if (resolvedFlow) {
            await tx
              .update(tasks)
              .set({
                launchMode: "manual",
                delegationSpec: {
                  kind: "flow",
                  flowId: resolvedFlow.flowId,
                  ...(body.runnerOverride
                    ? { runnerOverride: body.runnerOverride }
                    : {}),
                },
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, childTaskId));
          }

          // parent_of from the orchestrator's task to the child. Reserved for a
          // future AGENT orchestrator, where `runs.task_id` may legitimately be
          // null: today only the flow graph runner issues an orchestrator
          // token, and a flow run always has a task, so this branch is
          // unreachable — kept as a graceful log, never hardened into an assert.
          if (parent.taskId) {
            await addTaskRelation(
              {
                projectId: ctx.projectId,
                fromTaskId: parent.taskId,
                kind: "parent_of",
                toTaskId: childTaskId,
                actor: socialActorForToken(ctx.actor),
              },
              tx,
            );
          } else {
            log.info(
              { parentRunId, childTaskId },
              "delegation parent run has no task — child task created without a parent_of relation",
            );
          }
        });

        // Everything from here on is fallible AFTER the carrier transaction
        // committed, so the compensation below must wrap the ENTIRE remainder —
        // not a convenient tail.
        let childRunId: string;

        try {
          if (resolvedFlow) {
            const launched = await launchRun(
              {
                taskId: childTaskId as string,
                flowId: resolvedFlow.flowId,
                runnerId: body.runnerOverride ?? undefined,
                parentRunId,
                rootRunId,
                launchMode: "manual",
                delegationSnapshot: flowDelegationSnapshot(resolvedFlow, {
                  carrierTaskId: childTaskId as string,
                  mode: body.mode,
                  runnerOverride: body.runnerOverride ?? null,
                }),
              },
              // The token already scoped the project; there is no session user
              // to authorize against on an ext delegation.
              { actorUserId: null, authorize: async () => {} },
              db,
            );

            childRunId = launched.runId;
            log.info(
              {
                parentRunId,
                childRunId,
                childTaskId,
                targetKind: "flow",
                flowRefId: resolvedFlow.flowRefId,
                flowRevisionId: resolvedFlow.revisionId,
                mode: body.mode,
              },
              "[delegation.delegate] flow child launched",
            );
          } else {
            const result = await launchAgentRun({
              agentId: body.target.agentId as string,
              projectId: ctx.projectId,
              taskId: childTaskId ?? null,
              launchOverrideRunnerId: body.runnerOverride ?? null,
              parentRunId,
              rootRunId,
              launchMode: "manual",
              persistent: body.persistent ?? false,
              addressableKey: body.addressableKey ?? null,
              workspaceMode: body.workspaceMode ?? null,
              // M37 (ADR-100): honor the requested per-child workspace axis
              // (was previously parsed then dropped).
              workspace: body.workspace ?? null,
              trigger: { source: "manual" },
              db,
            });

            if ("deduped" in result) {
              // No trigger event id is set on a delegation, so this is
              // unreachable in practice — treat it as a precondition failure
              // rather than silently returning a phantom child.
              throw new MaisterError(
                "PRECONDITION",
                "delegated launch was unexpectedly deduped",
              );
            }

            childRunId = result.runId;
          }
        } catch (launchErr) {
          await compensateChildTask({
            db,
            childTaskId,
            parentRunId,
            code: isMaisterError(launchErr) ? launchErr.code : "UNKNOWN",
          });
          throw launchErr;
        }

        // W6: the orchestrator may have terminalized WHILE this child was
        // launching — the pre-flight check cannot see that, and the parent's own
        // cascade already ran before this child existed. Re-read the parent now
        // that the child row is committed and, if the tree is terminal, run the
        // SAME cascade a parent stop runs. Cascading from the PARENT (not the
        // child) is deliberate: the cascade abandons a run's DESCENDANTS and
        // leaves the root to its caller, and the just-born child is exactly one
        // of the parent's descendants. The already-terminal parent is untouched.
        const parentNow = await resolveActiveBoundRun(
          db,
          parentRunId,
          ctx.projectId,
        );

        if (!parentNow.ok) {
          // The cascade flips rows only; the just-born child may already hold
          // a live supervisor session that would otherwise keep spending
          // under the terminal tree.
          await cascadeAbandonRunTreeAndStopSessions(
            parentRunId,
            parent.taskId ?? null,
            "user_stopped",
            { db, logLabel: "[delegation.compensate]" },
          ).catch((cascadeErr: unknown) =>
            log.error(
              {
                parentRunId,
                childRunId,
                err:
                  cascadeErr instanceof Error
                    ? cascadeErr.message
                    : String(cascadeErr),
              },
              "[delegation.compensate] cascade of an orphaned child failed",
            ),
          );

          return NextResponse.json(
            { code: parentNow.code, message: parentNow.message },
            { status: httpStatusForExtCode(parentNow.code) },
          );
        }

        const result = { runId: childRunId };

        await recordRequiredTokenAudit(
          {
            tokenId: ctx.actor.tokenId,
            projectId: ctx.projectId,
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
