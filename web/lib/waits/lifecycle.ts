import "server-only";

import type { ExecutionAssignment } from "@/lib/db/schema";
import type { WaitResult } from "@/lib/waits/contracts";
import type { WaitCondition } from "@/lib/waits/manifest";
import type { WaitAddress, WaitRow, WaitTx } from "@/lib/waits/store";

import { createHash } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";
import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import {
  artifactInstances,
  executionAssignments,
  executionHosts,
  nodeAttempts,
  runs,
  runWaits,
  runWaitDeliveries,
  runPublications,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import {
  getLatestAssignment,
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { waitOutcomes } from "@/lib/waits/manifest";
import { ciReservationId } from "@/lib/waits/reservations";
import { isRelatedWaitRun, readObservedWaitFact } from "@/lib/waits/facts";
import { lockWait, persistWaitResult, readWaitClock } from "@/lib/waits/store";

const log = pino({
  name: "condition-wait-lifecycle",
  level: process.env.LOG_LEVEL ?? "info",
});

type ParkOwner = {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeAttemptId: string;
  readonly assignmentId: string;
};

async function lockParkOwner(tx: WaitTx, input: ParkOwner) {
  const [run] = await tx
    .select({
      status: runs.status,
      projectId: runs.projectId,
      assignmentId: runs.executionAssignmentId,
      nodeId: runs.currentStepId,
      flowRevision: runs.flowRevision,
      taskId: runs.taskId,
      parentRunId: runs.parentRunId,
    })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.runKind, "flow")))
    .for("update");

  if (
    !run ||
    run.status !== "Running" ||
    run.projectId !== input.projectId ||
    run.assignmentId !== input.assignmentId
  ) {
    throw new MaisterError("CONFLICT", "Wait park no longer owns its run", {
      details: { reason: "wait_owner_changed" },
    });
  }

  const [assignment] = await tx
    .select({ id: executionAssignments.id })
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, input.assignmentId),
        eq(executionAssignments.runId, input.runId),
        eq(executionAssignments.state, "active"),
      ),
    )
    .for("update");

  const [attempt] = await tx
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.id, input.nodeAttemptId),
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, run.nodeId ?? ""),
        eq(nodeAttempts.nodeType, "wait"),
        eq(nodeAttempts.status, "Running"),
        eq(nodeAttempts.executionAssignmentId, input.assignmentId),
      ),
    );

  if (!assignment || !attempt) {
    throw new MaisterError("CONFLICT", "Wait park no longer owns its attempt", {
      details: { reason: "wait_owner_changed" },
    });
  }

  return run;
}

async function waitSourceTarget(
  tx: WaitTx,
  input: ParkOwner,
  run: Awaited<ReturnType<typeof lockParkOwner>>,
  condition: WaitCondition,
): Promise<string | null> {
  switch (condition.kind) {
    case "comment":
      if (run.taskId) return run.taskId;
      throw new MaisterError("PRECONDITION", "A comment wait requires a task");
    case "signal":
      return condition.name;
    case "timer":
      return null;
    case "ci":
    case "pr": {
      const [attempt] = await tx
        .select({ id: nodeAttempts.id, status: nodeAttempts.status })
        .from(nodeAttempts)
        .where(
          and(
            eq(nodeAttempts.runId, input.runId),
            eq(nodeAttempts.nodeId, condition.publication),
            eq(nodeAttempts.nodeType, "publish"),
          ),
        )
        .orderBy(desc(nodeAttempts.attempt))
        .limit(1);
      const [publication] =
        attempt?.status === "Succeeded"
          ? await tx
              .select()
              .from(runPublications)
              .where(
                and(
                  eq(runPublications.projectId, input.projectId),
                  eq(runPublications.runId, input.runId),
                  eq(runPublications.nodeAttemptId, attempt.id),
                  eq(runPublications.flowRevision, run.flowRevision),
                  eq(runPublications.phase, "observed"),
                ),
              )
          : [];

      if (!publication || (condition.kind === "pr" && !publication.prNumber))
        throw new MaisterError(
          "PRECONDITION",
          "Provider wait lacks a current publication receipt",
          { details: { reason: "not_published" } },
        );

      return publication.id;
    }
    case "run": {
      const [target] = await tx
        .select({
          id: runs.id,
          projectId: runs.projectId,
          parentRunId: runs.parentRunId,
          taskId: runs.taskId,
        })
        .from(runs)
        .where(
          and(
            eq(runs.id, condition.run_id),
            eq(runs.projectId, input.projectId),
          ),
        );

      if (
        target &&
        (await isRelatedWaitRun(
          tx,
          { ...run, id: input.runId },
          target,
          condition,
        ))
      )
        return target.id;
      throw new MaisterError(
        "PRECONDITION",
        "Run wait requires the exact related run in this project",
        {
          details: { reason: "wait_unrelated_run" },
        },
      );
    }
  }
}

/** Persist intent before the driver requests or verifies host quiescence. */
export async function prepareConditionWait(
  tx: WaitTx,
  input: ParkOwner & {
    readonly condition: WaitCondition;
    readonly timeoutSeconds: number;
  },
): Promise<WaitRow> {
  const run = await lockParkOwner(tx, input);
  const id = createHash("sha256")
    .update(`flow-wait:${input.nodeAttemptId}`)
    .digest("hex");
  const [retained] = await tx
    .select()
    .from(runWaits)
    .where(
      and(
        eq(runWaits.nodeAttemptId, input.nodeAttemptId),
        eq(runWaits.runId, input.runId),
      ),
    );

  if (retained) {
    if (
      retained.state !== "parking" ||
      retained.nodeAttemptId !== input.nodeAttemptId ||
      retained.flowRevision !== run.flowRevision
    ) {
      throw new MaisterError("CONFLICT", "Wait park intent is already settled");
    }

    return retained;
  }

  const sourceTargetId = await waitSourceTarget(
    tx,
    input,
    run,
    input.condition,
  );
  const { kind, ...parameters } = input.condition;

  if (
    kind === "ci" &&
    input.condition.transport === "push" &&
    sourceTargetId &&
    run.nodeId
  ) {
    const [activated] = await tx
      .update(runWaits)
      .set({ state: "parking", nodeAttemptId: input.nodeAttemptId })
      .where(
        and(
          eq(runWaits.id, ciReservationId(sourceTargetId, run.nodeId)),
          eq(runWaits.runId, input.runId),
          eq(runWaits.state, "reserved"),
          sql`${runWaits.reservedUntil} > clock_timestamp()`,
        ),
      )
      .returning();

    if (activated) return activated;
  }
  const [intent] = await tx
    .insert(runWaits)
    .values({
      id,
      projectId: input.projectId,
      runId: input.runId,
      ownerKind: "flow",
      occurrenceKey: input.nodeAttemptId,
      nodeAttemptId: input.nodeAttemptId,
      flowRevision: run.flowRevision,
      conditionKind: kind,
      condition: {
        schemaVersion: 1,
        kind,
        outcomes: waitOutcomes(input.condition),
        parameters: { ...parameters, timeoutSeconds: input.timeoutSeconds },
      },
      state: "parking",
      sourceTargetId,
      publicationId: kind === "ci" || kind === "pr" ? sourceTargetId : null,
    })
    .returning();

  log.debug(
    { waitId: id, runId: input.runId, nodeAttemptId: input.nodeAttemptId },
    "wait park intent stored",
  );

  return intent;
}

function timerInstant(intent: WaitRow, openedAt: Date): Date | null {
  if (intent.conditionKind !== "timer") return null;
  const { until, after } = intent.condition.parameters;

  if (typeof after === "number")
    return new Date(openedAt.getTime() + after * 1000);
  if (typeof until === "string") return new Date(until);

  throw new MaisterError("CONFIG", "Retained timer wait has no due time");
}

/** Commit on the driver's transaction after exact host quiescence is confirmed. */
export async function commitConditionWaitPark(
  tx: WaitTx,
  input: ParkOwner &
    WaitAddress & {
      readonly maximumSeconds: number;
      readonly headSha?: string;
    },
): Promise<void> {
  await lockParkOwner(tx, input);
  const intent = await lockWait(tx, input);

  if (
    intent.state !== "parking" ||
    intent.nodeAttemptId !== input.nodeAttemptId
  ) {
    throw new MaisterError("CONFLICT", "Wait intent is no longer parkable");
  }
  const timeout = intent.condition.parameters.timeoutSeconds;

  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > input.maximumSeconds
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "Wait timeout exceeds this installation's maximum",
      {
        details: { reason: "wait_deadline_cap" },
      },
    );
  }
  if (
    intent.condition.parameters.bind === "head_sha" &&
    (!input.headSha || !GIT_OBJECT_ID.test(input.headSha))
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "A head-bound wait requires an observed workspace commit",
    );
  }

  const openedAt = await readWaitClock(tx);
  const [publication] = intent.publicationId
    ? await tx
        .select({ head: runPublications.sourceHead })
        .from(runPublications)
        .where(
          and(
            eq(runPublications.id, intent.publicationId),
            eq(runPublications.phase, "observed"),
          ),
        )
    : [];

  if (intent.publicationId && !publication)
    throw new MaisterError(
      "PRECONDITION",
      "Wait publication receipt is unavailable",
    );
  const timerAt = timerInstant(intent, openedAt);
  const deadlineAt = new Date(openedAt.getTime() + timeout * 1000);
  const absoluteCapAt = new Date(
    openedAt.getTime() + input.maximumSeconds * 1000,
  );

  await tx
    .update(runWaits)
    .set({
      state: "open",
      version: intent.version + 1,
      openedAt,
      timerAt,
      deadlineAt,
      absoluteCapAt,
      nextDueAt: timerAt && timerAt < deadlineAt ? timerAt : deadlineAt,
      registrationSnapshot: sql`pg_current_snapshot()::text`,
      bindingHeadSha: publication?.head ?? input.headSha ?? null,
    })
    .where(eq(runWaits.id, intent.id));
  await tx
    .update(runs)
    .set({ status: "Waiting" })
    .where(eq(runs.id, input.runId));
  await releaseAssignmentForRun(tx, input.runId, "waiting_condition", {
    now: openedAt,
  });
  await emitDomainEvent({
    db: tx,
    kind: "run.wait_registered",
    projectId: input.projectId,
    runId: input.runId,
    actor: { type: "system", id: null },
    occurredAt: openedAt,
    payload: { schemaVersion: 1, waitId: intent.id },
  });

  // The registration transaction already owns committed related-run facts and
  // can settle an elapsed timer without a scheduler tick or host round trip.
  if (intent.conditionKind === "timer" || intent.conditionKind === "run")
    await resolveEligibleConditionWait(tx, input);

  log.info(
    {
      waitId: intent.id,
      runId: input.runId,
      assignmentId: input.assignmentId,
      deadlineAt,
    },
    "condition wait parked and released its assignment",
  );
}

async function lockConditionWaitOwner(
  tx: WaitTx,
  address: WaitAddress,
): Promise<string | null> {
  const [run] = await tx
    .select({ status: runs.status, nodeId: runs.currentStepId })
    .from(runs)
    .where(
      and(eq(runs.id, address.runId), eq(runs.projectId, address.projectId)),
    )
    .for("update");

  return run?.status === "Waiting" ? run.nodeId : null;
}

/** Apply a verified fact and create the sole durable admission wake. */
export async function queueConditionWaitResume(
  tx: WaitTx,
  address: WaitAddress,
  expectedVersion: number,
  fact: Omit<WaitResult, "schemaVersion" | "resolvedAt">,
): Promise<void> {
  const nodeId = await lockConditionWaitOwner(tx, address);

  if (!nodeId) {
    throw new MaisterError("CONFLICT", "Run no longer owns an open wait");
  }

  const wait = await lockWait(tx, address);

  await applyConditionWaitResolution(tx, {
    address,
    wait,
    nodeId,
    expectedVersion,
    fact,
  });
}

async function applyConditionWaitResolution(
  tx: WaitTx,
  input: {
    address: WaitAddress;
    wait: WaitRow;
    nodeId: string;
    expectedVersion: number;
    fact: Omit<WaitResult, "schemaVersion" | "resolvedAt">;
  },
): Promise<void> {
  const { address, wait, nodeId, expectedVersion, fact } = input;

  if (wait.nodeAttemptId === null)
    throw new MaisterError("CONFLICT", "Wait has no activated graph attempt");
  const { result, digest } = await persistWaitResult(
    tx,
    address,
    expectedVersion,
    fact,
  );
  const resolvedAt = new Date(result.resolvedAt);
  const reportedData = result.data;
  const checkList = wait.condition.parameters.checks;
  const reportedChecks =
    reportedData &&
    typeof reportedData === "object" &&
    !Array.isArray(reportedData)
      ? (reportedData.checks ?? reportedData.failedChecks)
      : null;
  const failedChecks =
    Array.isArray(checkList) && Array.isArray(reportedChecks)
      ? checkList.filter(
          (name): name is string =>
            typeof name === "string" && reportedChecks.includes(name),
        )
      : [];
  const ciSummary =
    wait.conditionKind === "ci" && result.outcome !== "success"
      ? `CI report ${result.outcome}${failedChecks.length ? `: ${failedChecks.join(", ")}` : ""}`
      : undefined;
  const [attempt] = await tx
    .update(nodeAttempts)
    .set({
      status: "Succeeded",
      decision: result.outcome,
      vars: {
        waitOutcome: result.outcome,
        waitId: wait.id,
        waitSource: result.source,
        waitResolvedAt: result.resolvedAt,
        ...(ciSummary ? { ciFailureSummary: ciSummary } : {}),
        ...(wait.openedAt ? { waitOpenedAt: wait.openedAt.toISOString() } : {}),
        ...(wait.bindingHeadSha
          ? { waitBoundHeadSha: wait.bindingHeadSha }
          : {}),
      },
      endedAt: resolvedAt,
    })
    .where(
      and(
        eq(nodeAttempts.id, wait.nodeAttemptId),
        eq(nodeAttempts.runId, address.runId),
        eq(nodeAttempts.nodeId, nodeId),
        eq(nodeAttempts.nodeType, "wait"),
        eq(nodeAttempts.status, "Running"),
      ),
    )
    .returning({ attempt: nodeAttempts.attempt });

  if (!attempt)
    throw new MaisterError(
      "CONFLICT",
      "Wait attempt changed before resolution",
    );

  // Generic evidence consumers may receive inline locators. Raw source data
  // is available only through the wait projection's disclosure check.
  const { data, ...evidence } = result;
  const text = canonicalCommandJson({
    ...evidence,
    waitId: wait.id,
    resultDigest: digest,
    dataRestricted: data !== undefined,
  });

  await tx.insert(artifactInstances).values({
    id: `wait-result:${wait.nodeAttemptId}`,
    runId: address.runId,
    nodeAttemptId: wait.nodeAttemptId,
    nodeId,
    attempt: attempt.attempt,
    kind: "wait-result",
    artifactDefId: "wait-result",
    producer: "runner",
    locator: { kind: "inline", text },
    hash: createHash("sha256").update(text).digest("hex"),
    sizeBytes: Buffer.byteLength(text, "utf8"),
    visibility: "internal",
  });
  await tx
    .update(runs)
    .set({ status: "Pending" })
    .where(eq(runs.id, address.runId));
  await tx
    .update(runWaitDeliveries)
    .set({
      application: sql`CASE WHEN ${result.source === "signal"} AND ${runWaitDeliveries.id} = ${result.sourceId} THEN 'applied' ELSE 'not_applied' END`,
    })
    .where(
      and(
        eq(runWaitDeliveries.waitId, wait.id),
        eq(runWaitDeliveries.application, "pending"),
      ),
    );
  await emitDomainEvent({
    db: tx,
    kind: "run.wait_resolved",
    projectId: address.projectId,
    runId: address.runId,
    actor: { type: "system", id: null },
    occurredAt: resolvedAt,
    payload: {
      schemaVersion: 1,
      waitId: wait.id,
      outcome: result.outcome,
      source: result.source,
    },
  });

  log.debug(
    { ...address, outcome: result.outcome },
    "resolved wait queued for admission",
  );
}

/** Select the first eligible fact before sealing an expired deadline. */
export async function resolveEligibleConditionWait(
  tx: WaitTx,
  address: WaitAddress,
  observedHeadSha?: string,
): Promise<boolean> {
  const nodeId = await lockConditionWaitOwner(tx, address);

  if (!nodeId) return false;

  const wait = await lockWait(tx, address);

  if (wait.state !== "open") return false;

  const fact = await readObservedWaitFact(tx, wait, observedHeadSha);
  const winner = fact ?? (await readDueWaitFact(tx, wait.id));

  if (!winner) return false;

  await applyConditionWaitResolution(tx, {
    address,
    wait,
    nodeId,
    expectedVersion: wait.version,
    fact: winner,
  });

  return true;
}

async function readDueWaitFact(
  tx: WaitTx,
  waitId: string,
): Promise<Omit<WaitResult, "schemaVersion" | "resolvedAt"> | null> {
  const [due] = await tx
    .select({
      elapsed: sql<boolean>`${runWaits.timerAt} < ${runWaits.deadlineAt}`,
    })
    .from(runWaits)
    .where(
      and(
        eq(runWaits.id, waitId),
        sql`${runWaits.nextDueAt} <= clock_timestamp()`,
      ),
    );

  return due
    ? {
        source: "timer",
        sourceId: waitId,
        outcome: due.elapsed ? "elapsed" : "timeout",
      }
    : null;
}

/** Called only inside the common scheduler lock after the normal capacity and owner checks. */
export async function admitConditionWaitResume(
  tx: WaitTx,
  address: WaitAddress,
): Promise<ExecutionAssignment | null> {
  const [run] = await tx
    .select({ status: runs.status, assignmentId: runs.executionAssignmentId })
    .from(runs)
    .where(
      and(eq(runs.id, address.runId), eq(runs.projectId, address.projectId)),
    )
    .for("update");

  if (run?.status !== "Pending") return null;

  const wait = await lockWait(tx, address);

  if (wait.resumeState !== "queued") return null;
  const original = await getLatestAssignment(tx, address.runId);

  if (
    !original ||
    original.id !== run.assignmentId ||
    original.state !== "released" ||
    original.releasedReason !== "waiting_condition"
  ) {
    return null;
  }

  const [host] = await tx
    .select({ readiness: executionHosts.readiness })
    .from(executionHosts)
    .where(
      and(
        eq(executionHosts.id, original.executionHostId),
        isNull(executionHosts.retiredAt),
      ),
    );

  if (host?.readiness !== "ready") return null;

  const assignment = await mintAssignment(tx, {
    runId: address.runId,
    reason: "wait_resume",
    hostId: original.executionHostId,
  });

  await tx
    .update(runWaits)
    .set({
      resumeState: "admitted",
      resumeAssignmentId: assignment.id,
      version: wait.version + 1,
    })
    .where(eq(runWaits.id, wait.id));
  await tx
    .update(runs)
    .set({ status: "Running" })
    .where(eq(runs.id, address.runId));

  log.debug(
    { ...address, assignmentId: assignment.id, epoch: assignment.epoch },
    "wait continuation admitted",
  );

  return assignment;
}

export async function admittedConditionWait(
  tx: Pick<WaitTx, "select">,
  runId: string,
  assignmentId: string,
) {
  const [wait] = await tx
    .select({
      id: runWaits.id,
      nodeAttemptId: runWaits.nodeAttemptId,
      flowRevision: runWaits.flowRevision,
      result: runWaits.result,
    })
    .from(runWaits)
    .where(
      and(
        eq(runWaits.runId, runId),
        eq(runWaits.resumeAssignmentId, assignmentId),
        eq(runWaits.resumeState, "admitted"),
      ),
    );

  return wait ?? null;
}

export async function canRedriveConditionWait(
  tx: Pick<WaitTx, "select">,
  runId: string,
  assignmentId: string,
  nodeId: string,
): Promise<boolean> {
  const [candidate] = await tx
    .select({ id: runWaits.id })
    .from(runWaits)
    .innerJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.id, runWaits.nodeAttemptId),
        eq(nodeAttempts.runId, runId),
      ),
    )
    .where(
      and(
        eq(runWaits.runId, runId),
        eq(nodeAttempts.nodeId, nodeId),
        sql`(
      (${runWaits.state} = 'parking' AND ${nodeAttempts.executionAssignmentId} = ${assignmentId})
      OR (${runWaits.resumeState} = 'admitted' AND ${runWaits.resumeAssignmentId} = ${assignmentId})
    )`,
      ),
    );

  return candidate !== undefined;
}

export async function finishConditionWaitResume(
  tx: Pick<WaitTx, "update">,
  waitId: string,
  assignmentId: string,
): Promise<void> {
  const [applied] = await tx
    .update(runWaits)
    .set({
      resumeState: "applied",
      version: sql`${runWaits.version} + 1`,
    })
    .where(
      and(
        eq(runWaits.id, waitId),
        eq(runWaits.resumeAssignmentId, assignmentId),
        eq(runWaits.resumeState, "admitted"),
      ),
    )
    .returning({ id: runWaits.id });

  if (!applied)
    throw new MaisterError("CONFLICT", "Wait continuation claim changed");
}
