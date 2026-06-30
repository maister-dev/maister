import "server-only";

import type { QueueWriteFields } from "@/lib/tasks/queue-fields";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  applyTriageFlag,
  applyTriageVerdict,
  setTaskQueueFields,
  validateVerdictRefs,
} from "@/lib/services/triage";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { tasks } = schemaModule as unknown as Record<string, any>;

const ENDPOINT_TRIAGE =
  "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/triage";

// ADR-089 D8 / ADR-112: at least one field. A verdict body (flowId / runnerId /
// baseBranch / targetBranch / promotionMode) stamps triage_status='triaged'; a
// `flag: true` body stamps 'flagged' (held). `flag` is mutually exclusive with
// every verdict field (enforced below → 422 CONFIG). `enqueue: true` additionally
// sets launch_mode='auto' (the auto_launch_triaged tick fires the run) — valid
// ONLY alongside a verdict that sets a flowId (else 422 CONFIG).
const VERDICT_FIELDS = [
  "flowId",
  "runnerId",
  "baseBranch",
  "targetBranch",
  "promotionMode",
] as const;

const postBodySchema = z
  .object({
    flowId: z.string().min(1).optional(),
    runnerId: z.string().min(1).optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    targetBranch: z.string().min(1).max(255).optional(),
    promotionMode: z.enum(["local_merge", "pull_request"]).optional(),
    flag: z.boolean().optional(),
    enqueue: z.boolean().optional(),
    // ADR-121 (F6): priority + advisory confidence — INDEPENDENT of `flag` and the
    // verdict fields (settable alongside either). `null` clears (priority → 'normal',
    // confidence → NULL). Out-of-range confidence → 422 (wire validation + DB CHECK).
    priority: z.enum(["low", "normal", "high", "urgent"]).nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };
type TransactionalDb = {
  transaction<T>(scope: (tx: unknown) => Promise<T>): Promise<T>;
};

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
      scopeLabel: "tasks:triage",
      endpoint: ENDPOINT_TRIAGE,
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

      // taskId ownership re-validated against the token's project (ext
      // idiom — cross-project access hides existence with 404).
      const taskRows = await (db as { select: any })
        .select({ id: tasks.id, flowId: tasks.flowId })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)));

      if (taskRows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      // ADR-112: `flag` is mutually exclusive with every verdict field —
      // a held duplicate / rejected intake carries no launch verdict.
      const flagged = body.flag === true;
      const verdictFieldsPresent = VERDICT_FIELDS.filter(
        (f) => body[f] !== undefined,
      );

      if (flagged && verdictFieldsPresent.length > 0) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `flag is mutually exclusive with verdict fields (${verdictFieldsPresent.join(", ")})`,
          },
          { status: 422 },
        );
      }

      // ADR-112 / OpenAPI: `enqueue` arms the auto_launch_triaged tick — valid
      // when the flow resolves from EITHER this body OR the task's existing
      // flow_id (the task ends with a non-null flow_id). `enqueue` + `flag` is
      // excluded by the mutual-exclusion above.
      const enqueue = body.enqueue === true;
      const resolvableFlowId = body.flowId ?? taskRows[0].flowId ?? undefined;

      if (enqueue && (flagged || resolvableFlowId === undefined)) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message:
              "enqueue requires a verdict that yields a flowId (in the body or the task's existing flow)",
          },
          { status: 422 },
        );
      }

      // ADR-121 (F6): priority/confidence ride alongside whichever triage action
      // the agent performs (flag / verdict / pure update) — never gated by `flag`.
      // `null` = explicit clear (priority → 'normal', confidence → NULL); absent =
      // leave unchanged.
      const queueFields: QueueWriteFields = {};

      if (body.priority !== undefined) queueFields.priority = body.priority;
      if (body.confidence !== undefined) {
        queueFields.triageConfidence = body.confidence;
      }

      const auditOk = (tx: unknown) =>
        recordRequiredTokenAudit(
          {
            tokenId: ctx.actor.tokenId,
            projectId: ctx.projectId,
            actorLabel: ctx.actor.actorLabel,
            scopeUsed: "tasks:triage",
            endpoint: ENDPOINT_TRIAGE,
            method: "POST",
            result: "ok",
            statusCode: 200,
          },
          tx,
        );

      try {
        const actor = socialActorForToken(ctx.actor);

        if (flagged) {
          await (db as TransactionalDb).transaction(async (tx) => {
            await applyTriageFlag(tx, {
              taskId,
              projectId: ctx.projectId,
              actor,
              queueFields,
            });

            await auditOk(tx);
          });

          return NextResponse.json(
            { ok: true, triageStatus: "flagged" },
            { status: 200 },
          );
        }

        // ADR-121: a body carrying ONLY priority/confidence (no flag, no verdict
        // field, no enqueue) is a pure queue-field update — it must NOT stamp
        // 'triaged' or change launch_mode.
        const isPureQueueUpdate = verdictFieldsPresent.length === 0 && !enqueue;

        if (isPureQueueUpdate) {
          await (db as TransactionalDb).transaction(async (tx) => {
            await setTaskQueueFields(tx, {
              taskId,
              projectId: ctx.projectId,
              actor,
              queueFields,
            });

            await auditOk(tx);
          });

          return NextResponse.json({ ok: true }, { status: 200 });
        }

        // Narrow to verdict fields only — `enqueue` is not a verdict column
        // and must not leak into the verdict / activity payload.
        const verdict = {
          flowId: body.flowId,
          runnerId: body.runnerId,
          baseBranch: body.baseBranch,
          targetBranch: body.targetBranch,
          promotionMode: body.promotionMode,
        };

        await validateVerdictRefs(ctx.projectId, verdict, db);

        await (db as TransactionalDb).transaction(async (tx) => {
          await applyTriageVerdict(tx, {
            taskId,
            projectId: ctx.projectId,
            verdict,
            actor,
            enqueue,
            queueFields,
          });

          await auditOk(tx);
        });

        return NextResponse.json(
          { ok: true, triageStatus: "triaged" },
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
