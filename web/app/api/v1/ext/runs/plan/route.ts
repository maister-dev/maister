import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { launchAgentRun } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, type MaisterError } from "@/lib/errors";
import { orchestratorMaxFanout } from "@/lib/instance-config";
import {
  type DelegatableFlow,
  flowDelegationSnapshot,
  resolveDelegatableFlow,
} from "@/lib/flows/delegatable-flow";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { noteAsPlanRefusal } from "@/lib/orchestrator/as-plan-refusal";
import {
  type DelegationTarget,
  delegationTargetKind,
  delegationTargetSchema,
  refuseUnsupportedDelegationOption,
  titleFromPrompt,
} from "@/lib/orchestrator/delegation-target";
import { launchRun } from "@/lib/services/runs";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
import { addTaskRelation } from "@/lib/social/relations";
import { abandonUnlaunchedTasks, createTask } from "@/lib/services/tasks";
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

type PlanResultItem = {
  key: string;
  taskId: string;
  childRunId?: string;
  launchError?: { code: string; message: string };
};

type SourceRefusal = {
  key: string;
  taskId: string;
  code: MaisterError["code"];
  message: string;
};

const planTaskSchema = z
  .object({
    key: z.string().min(1),
    // ADR-163: the SAME discriminated target both delegation entry points use.
    target: delegationTargetSchema,
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

/** The body-supplied ref an entry named, for refusal messages. */
function targetRef(target: DelegationTarget): string {
  return target.flowId ?? target.agentId ?? "?";
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

      // ADR-163: a cheap pre-check so an obviously oversized batch is refused
      // before any resolution work. It cannot see the orchestrator's running
      // children; the DAG transaction's `admitDelegatedChild(live + batch
      // size)` can, but inserts no runs, so the DECISIVE bound is the one
      // inside each launcher's run-insert transaction (ADR-163 D8 amendment).
      if (planTasks.length > orchestratorMaxFanout()) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `plan fan-out limit reached (${orchestratorMaxFanout()})`,
          },
          { status: httpStatusForExtCode("CONFIG") },
        );
      }

      // ADR-163 D4: the per-kind option allow-list is a SHAPE rule, settled
      // BEFORE any resolution work with the same code and status `run_delegate`
      // gives the same field — every violating entry reported at once. An
      // as-plan entry always mints a task, so `mode` is fixed to "task".
      const optionRefusals = planTasks.flatMap((t) => {
        const refusal = refuseUnsupportedDelegationOption(
          delegationTargetKind(t.target),
          { mode: "task", title: t.title, workspace: t.workspace },
        );

        return refusal ? [`${t.key} (${targetRef(t.target)}): ${refusal}`] : [];
      });

      if (optionRefusals.length > 0) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `unsupported plan options: ${optionRefusals.join("; ")}`,
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

      // (d) run-tree depth is enforced by `admitDelegatedChild` inside the DAG
      // transaction (ADR-163) — the same helper, the same walk, the same lock as
      // every other child-creation edge. The copy that used to live here is gone.

      // (e) every target must resolve (enablement+trust+pinned revision).
      // Collect ALL failures so the caller sees every bad target at once; NO
      // rows are written on any failure.
      //
      // ADR-163: the target is a discriminated union, so the resolver is chosen
      // per entry — the agent catalog for one, the project's enabled+trusted
      // flows for the other. A batch may MIX both kinds. Every typed refusal is
      // collected with ITS code; anything else is a real fault and propagates.
      const resolveFailures: {
        key: string;
        ref: string;
        code: MaisterError["code"];
        message: string;
      }[] = [];
      const resolvedFlows = new Map<string, DelegatableFlow>();

      const collectRefusal = async (
        t: PlanTask,
        resolve: () => Promise<void>,
      ): Promise<void> => {
        try {
          await resolve();
        } catch (err) {
          if (!isMaisterError(err)) throw err;
          resolveFailures.push({
            key: t.key,
            ref: targetRef(t.target),
            code: err.code,
            message: err.message,
          });
        }
      };

      for (const t of planTasks) {
        if (delegationTargetKind(t.target) === "flow") {
          await collectRefusal(t, async () => {
            resolvedFlows.set(
              t.key,
              await resolveDelegatableFlow(
                {
                  projectId: ctx.projectId,
                  flowId: t.target.flowId as string,
                },
                db,
              ),
            );
          });
          continue;
        }

        await collectRefusal(t, async () => {
          await resolveEffectiveAgentDefinition(
            { agentId: t.target.agentId as string, projectId: ctx.projectId },
            db,
          );
        });
      }

      if (resolveFailures.length > 0) {
        // One shared code when the batch agrees (what `run_delegate` answers for
        // any entry alone); a MIXED batch aggregates to the conservative
        // PRECONDITION, every line still tagged with its own code.
        const codes = new Set(resolveFailures.map((f) => f.code));
        const code: MaisterError["code"] =
          codes.size === 1 ? resolveFailures[0].code : "PRECONDITION";

        return NextResponse.json(
          {
            code,
            message: `unresolvable plan targets: ${resolveFailures
              .map((f) => `${f.key} (${f.ref}): [${f.code}] ${f.message}`)
              .join("; ")}`,
          },
          { status: httpStatusForExtCode(code) },
        );
      }

      // --- Create the whole DAG in ONE transaction ---
      let keyToTaskId: Map<string, string>;

      try {
        keyToTaskId = await db.transaction(async (tx: Db) => {
          const map = new Map<string, string>();

          // ADR-163: the whole batch is admitted ONCE, under the
          // per-orchestrator lock, as `live children + batch size` — replacing
          // the pre-ADR-163 check that compared the batch LENGTH alone against
          // the cap and so ignored every child already running.
          await admitDelegatedChild(tx, {
            parentRunId: parent.id,
            incoming: planTasks.length,
          });

          for (const t of planTasks) {
            const resolvedFlow = resolvedFlows.get(t.key) ?? null;
            const created = await createTask(
              {
                title: t.title ?? titleFromPrompt(t.prompt),
                prompt: t.prompt,
                // A flow entry's task carries the SELECTED flow; an agent
                // entry's task stays flowless (a simple-intent task awaiting
                // triage), unchanged.
                flowId: resolvedFlow?.flowId ?? null,
              },
              { projectId: ctx.projectId, actorUserId: null },
              tx,
            );

            // Stamp the as-plan launch intent — createTask does not accept it.
            // The spec is `kind`-discriminated (ADR-163) so the auto-launcher
            // dispatches on it rather than sniffing for `agentId`.
            await tx
              .update(tasks)
              .set({
                launchMode: "auto",
                delegationSpec: resolvedFlow
                  ? {
                      kind: "flow" as const,
                      flowId: resolvedFlow.flowId,
                      ...(t.runnerOverride
                        ? { runnerOverride: t.runnerOverride }
                        : {}),
                    }
                  : {
                      kind: "agent" as const,
                      agentId: t.target.agentId as string,
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
      // Codex review F3: a PARTIAL source refusal must NOT roll back the
      // committed DAG — the refused task stays Backlog, carries the refusal on
      // its result row and as a system comment, and the auto-launcher retries
      // it when a sibling child next settles. When EVERY source is refused
      // nothing runs and nothing will ever settle: the DAG is abandoned
      // (parity with run_delegate's compensation) and the refusal is the
      // answer, because the parent — counting zero child RUNS — would
      // otherwise complete its node over a dead DAG.
      const result: PlanResultItem[] = [];
      const refused: SourceRefusal[] = [];
      let attempted = 0;

      for (const t of planTasks) {
        const childTaskId = keyToTaskId.get(t.key)!;
        const entry: PlanResultItem = { key: t.key, taskId: childTaskId };

        if (t.dependsOn.length === 0) {
          const resolvedFlow = resolvedFlows.get(t.key) ?? null;

          attempted += 1;

          try {
            // ADR-163: branch on the entry's target kind BEFORE calling a
            // kind-specific launcher. A flow source goes through the canonical
            // flow pipeline with its carrier task (the as-plan task IS the
            // carrier here — it already exists and already carries the flow).
            if (resolvedFlow) {
              const launched = await launchRun(
                {
                  taskId: childTaskId,
                  flowId: resolvedFlow.flowId,
                  runnerId: t.runnerOverride ?? undefined,
                  parentRunId,
                  rootRunId,
                  launchMode: "auto",
                  delegationSnapshot: flowDelegationSnapshot(resolvedFlow, {
                    carrierTaskId: childTaskId,
                    mode: "task",
                    runnerOverride: t.runnerOverride ?? null,
                  }),
                },
                { actorUserId: null, authorize: async () => {} },
                db,
              );

              entry.childRunId = launched.runId;
            } else {
              const launched = await launchAgentRun({
                agentId: t.target.agentId as string,
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
            }

            log.info(
              {
                parentRunId,
                key: t.key,
                taskId: childTaskId,
                targetKind: resolvedFlow ? "flow" : "agent",
                childRunId: entry.childRunId,
              },
              "[delegation.plan] source task launched",
            );
          } catch (err) {
            const code: MaisterError["code"] = isMaisterError(err)
              ? err.code
              : "CRASH";
            const message = err instanceof Error ? err.message : String(err);

            refused.push({ key: t.key, taskId: childTaskId, code, message });
            entry.launchError = { code, message };
            log.warn(
              {
                parentRunId,
                key: t.key,
                taskId: childTaskId,
                targetKind: resolvedFlow ? "flow" : "agent",
                agentId: t.target.agentId,
                flowId: t.target.flowId,
                code,
                err: message,
              },
              "[delegation.plan] source task launch refused",
            );
          }
        }

        result.push(entry);
      }

      if (attempted > 0 && refused.length === attempted) {
        const abandoned = await abandonUnlaunchedTasks(
          db,
          [...keyToTaskId.values()],
          new Date(),
        );
        // One shared code when the sources agree; a MIXED batch aggregates to
        // the conservative PRECONDITION, every line still tagged with its own
        // code (the resolution-failure convention above).
        const codes = new Set(refused.map((r) => r.code));
        const code: MaisterError["code"] =
          codes.size === 1 ? refused[0].code : "PRECONDITION";

        log.warn(
          {
            parentRunId,
            code,
            abandonedTaskIds: abandoned,
            refused: refused.map((r) => ({ key: r.key, code: r.code })),
          },
          "[delegation.plan.compensate] every source launch refused — plan abandoned",
        );

        return NextResponse.json(
          {
            code,
            message: `unlaunchable plan sources: ${refused
              .map((r) => `${r.key}: [${r.code}] ${r.message}`)
              .join("; ")}`,
          },
          { status: httpStatusForExtCode(code) },
        );
      }

      for (const r of refused) {
        await noteAsPlanRefusal(
          db,
          { taskId: r.taskId },
          { code: r.code, message: r.message },
        );
      }

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

      return NextResponse.json({ tasks: result }, { status: 202 });
    },
  );
}
