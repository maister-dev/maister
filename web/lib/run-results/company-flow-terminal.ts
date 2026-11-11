import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { Run } from "@/lib/db/schema";
import type { MaisterErrorCode } from "@/lib/errors";
import type { TerminalCause } from "@/lib/domain-events/taxonomy";
import type { DomainEventActor } from "@/lib/domain-events/outbox";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import {
  isCompanyFlowResource,
  inspectOperationalRun,
} from "@/lib/agents/operational-context";
import { authorizeCompanyRunUserAction } from "@/lib/agents/company-run-read-access";
import { TERMINAL_CAS_SOURCE } from "@/lib/agents/finalization";
import { initialResourceCleanup } from "@/lib/agents/resource-cleanup";
import {
  readAgentDispatchEvidence,
  assertAgentExecutionQuiescent,
  waitForAgentExecutionQuiescence,
  assertAgentCancellationExecutionQuiescent,
  assertAgentSessionBindingsQuiescent,
  assertAgentCancellationBindingsQuiescent,
} from "@/lib/agents/execution-quiescence";
import { revokeAgentRunTokensForRun } from "@/lib/agents/tokens";
import {
  resolvePublicResult,
  recordInvalidRunResult,
} from "@/lib/run-results/ledger";
import { deriveResultStatus } from "@/lib/run-results/status";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import {
  systemCloseActiveAssignmentsForRun,
  cancelActiveAssignmentsForRun,
  ensureCompanyUserActor,
} from "@/lib/assignments/service";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { hitlRequests, runs } from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { closedAnswerResponse } from "@/lib/hitl-closed-answer";
import { gcAgeDays } from "@/lib/instance-config";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import { MaisterError } from "@/lib/errors";
import { currentBudgetTermination } from "@/lib/runs/budget-termination";

const log = pino({
  name: "company-flow-terminal",
  level: process.env.LOG_LEVEL ?? "info",
});

function terminalWitness(run: Run): string {
  return contentDigest({
    owner: run.companyExecutionSnapshot,
    assignmentId: run.executionAssignmentId,
    driverToken: run.flowDriverToken,
    cancellation: run.companyCancellationIntent,
    contract: run.resultContract,
    baseline: run.operationalIntegrityBaseline,
    knowledgeAccess: run.knowledgeAccess,
  });
}

/** Settle the existing graph ledger with a required public result and a quiescent, witnessed plain directory. */
export async function finalizeCompanyFlowRun(
  args: {
    db: Db;
    rootDb: Db;
    runId: string;
    errorCode: MaisterErrorCode | null;
    reason?: string;
    hosts?: ExecutionHosts;
    driverToken?: string;
    budgetTerminationId?: string;
    signal?: AbortSignal;
  } & (
    | { requested: "Done" | "Failed" | "Crashed" }
    | { requested: "Abandoned"; userId: string; cascadeParentRunId?: never }
    | { requested: "Abandoned"; userId?: never; cascadeParentRunId: string }
  ),
): Promise<boolean> {
  const [run] = await args.db
    .select()
    .from(runs)
    .where(eq(runs.id, args.runId));

  if (!run || !isCompanyFlowResource(run) || run.companyId === null)
    throw new MaisterError(
      "PRECONDITION",
      "Company graph finalization requires its exact retained execution owner",
    );
  const sourceStatuses = TERMINAL_CAS_SOURCE[args.requested];

  if (!sourceStatuses.includes(run.status)) return false;
  const operatorId = args.requested === "Abandoned" ? args.userId : undefined;

  if (operatorId !== undefined)
    await authorizeCompanyRunUserAction(
      args.db,
      operatorId,
      run.id,
      "assignments:cancel",
    );
  const contract = run.resultContract;
  const producerRef = contract.producerNodeIds[0];

  if (!producerRef)
    throw new MaisterError(
      "CONFIG",
      "The retained company Flow result contract has no producer identity",
    );
  if (
    run.flowDriverToken !== null &&
    run.flowDriverToken !== args.driverToken &&
    run.flowDriverLeaseExpiresAt !== null &&
    run.flowDriverLeaseExpiresAt.getTime() > Date.now()
  )
    throw new MaisterError(
      "CONFLICT",
      "The current graph traversal still owns company execution preparation",
      { details: { reason: "flow_driver_owned" } },
    );
  const companyId = run.companyId;
  const dispatch = await readAgentDispatchEvidence(args.rootDb, run.id);
  const dispatched = dispatch.hasOwnedCommand || dispatch.hasBoundSession;

  if (dispatched && args.requested !== "Abandoned")
    await waitForAgentExecutionQuiescence(
      args.rootDb,
      run,
      args.signal,
      args.hosts,
    );
  else if (dispatched)
    await assertAgentExecutionQuiescent(
      args.rootDb,
      run,
      undefined,
      args.hosts,
    );
  else
    await assertAgentCancellationExecutionQuiescent(
      args.rootDb,
      run,
      args.hosts,
    );
  const publicResult = await resolvePublicResult(args.db, run.id);
  const resultStatus = deriveResultStatus({
    runStatus: "Review",
    contract: run.resultContract,
    newestRow: publicResult.newest,
    validRow: publicResult.valid,
  });
  const integrity = await inspectOperationalRun(args.rootDb, run);
  const successful =
    args.requested === "Done" &&
    dispatched &&
    resultStatus === "valid" &&
    integrity.verdict === "clean";
  const status =
    args.requested === "Abandoned"
      ? "Abandoned"
      : successful
        ? "Done"
        : args.requested === "Crashed"
          ? "Crashed"
          : "Failed";
  const resultReason =
    resultStatus === "missing"
      ? "result_missing"
      : resultStatus === "invalid"
        ? "result_invalid"
        : resultStatus === "stale"
          ? "result_stale"
          : "result_unavailable";
  const reason =
    args.reason ??
    (resultStatus !== "valid"
      ? resultReason
      : integrity.verdict !== "clean"
        ? "company_flow_integrity_refused"
        : !dispatched
          ? "company_flow_dispatch_unproven"
          : args.requested === "Done"
            ? "graph_completed"
            : "graph_execution_failed");
  const endedAt = new Date();
  const cleanup = initialResourceCleanup({
    resourceKind: "plain_directory",
    workspace: "none",
    state: status === "Crashed" ? "retained" : "armed",
    armedAt: endedAt.toISOString(),
    dueAt: new Date(
      endedAt.getTime() + (status === "Crashed" ? gcAgeDays() * 86400000 : 0),
    ).toISOString(),
  });
  const finalized = await args.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, run.id))
      .for("update");

    if (!current || !sourceStatuses.includes(current.status)) return false;
    const budgetStop = await currentBudgetTermination(tx, current);

    if (budgetStop?.id !== args.budgetTerminationId) return false;
    if (current.companyCancellationIntent && operatorId === undefined)
      return false;
    if (
      operatorId !== undefined &&
      current.companyCancellationIntent?.userId !== operatorId
    )
      throw new MaisterError(
        "CONFLICT",
        "Company Flow cancellation requires its retained operator intent",
        { details: { reason: "company_stop_owned" } },
      );
    if (operatorId !== undefined)
      await authorizeCompanyRunUserAction(
        tx,
        operatorId,
        run.id,
        "assignments:cancel",
      );
    if (
      args.requested === "Abandoned" &&
      args.cascadeParentRunId !== undefined &&
      current.parentRunId !== args.cascadeParentRunId
    )
      return false;
    if (terminalWitness(current) !== terminalWitness(run))
      throw new MaisterError(
        "CONFLICT",
        "Company graph terminal witnesses changed after preparation",
      );
    const currentResult = await resolvePublicResult(tx, run.id);

    if (
      currentResult.valid?.id !== publicResult.valid?.id ||
      currentResult.newest?.id !== publicResult.newest?.id
    )
      throw new MaisterError(
        "CONFLICT",
        "Company graph public result changed after terminal preparation",
      );
    if (dispatched) await assertAgentSessionBindingsQuiescent(tx, current);
    else await assertAgentCancellationBindingsQuiescent(tx, current);
    await tx
      .update(runs)
      .set({
        status,
        endedAt,
        currentStepId: null,
        operationalCleanup: cleanup,
      })
      .where(and(eq(runs.id, run.id), eq(runs.status, current.status)));
    if (args.requested === "Done" && resultStatus === "missing")
      await recordInvalidRunResult(tx, {
        runId: run.id,
        contract,
        reason: "result_missing",
        producerKind: "flow_node",
        producerRef,
      });
    await revokeAgentRunTokensForRun(run.id, tx);
    await releaseAssignmentForRun(tx, run.id, "run_terminal");
    await tx
      .update(hitlRequests)
      .set({
        respondedAt: endedAt,
        response: closedAnswerResponse("session_ended", endedAt),
      })
      .where(
        and(eq(hitlRequests.runId, run.id), isNull(hitlRequests.respondedAt)),
      );
    let actor: DomainEventActor = { type: "system", id: null };

    if (operatorId !== undefined) {
      const human = await ensureCompanyUserActor({
        db: tx,
        companyId,
        userId: operatorId,
      });

      await cancelActiveAssignmentsForRun({
        db: tx,
        runId: run.id,
        actorId: human.id,
        eventKind: "cancelled",
        reason: "Company Flow Run stopped by operator",
      });
      actor = { type: "user", id: operatorId };
    } else {
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId: run.id,
        reason: "company graph execution settled",
      });
    }
    const scope = {
      db: tx,
      companyId,
      runId: run.id,
      parentRunId: run.parentRunId,
      actor,
      payload: {
        runId: run.id,
        flowId: null,
        taskId: null,
        runKind: "flow",
        reason,
        resultStatus,
        resultRevision: publicResult.valid?.revision ?? null,
        integrity: integrity.verdict,
        baselineGeneration:
          run.operationalIntegrityBaseline?.generation ?? null,
      },
    };

    if (status === "Done")
      await emitDomainEvent({ ...scope, kind: "run.done" });
    else {
      const cause: TerminalCause = {
        code: status === "Abandoned" ? null : (args.errorCode ?? "CONFIG"),
        reason,
        source:
          operatorId !== undefined
            ? "operator"
            : status === "Abandoned"
              ? "orchestrator"
              : "graph",
      };

      await emitDomainEvent({
        ...scope,
        kind:
          status === "Abandoned"
            ? "run.abandoned"
            : status === "Crashed"
              ? "run.crashed"
              : "run.failed",
        cause,
      });
    }

    return true;
  });

  log.info(
    {
      runId: run.id,
      companyId: run.companyId,
      status,
      reason,
      resultStatus,
      integrity: integrity.verdict,
      finalized,
    },
    "company graph terminal contract evaluated",
  );
  if (finalized)
    await disposeOperationalRun(run.id, { db: args.rootDb, hosts: args.hosts });

  return finalized;
}
