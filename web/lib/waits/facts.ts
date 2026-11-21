import "server-only";

import type { WaitResult } from "@/lib/waits/contracts";
import type { WaitRow, WaitTx } from "@/lib/waits/store";

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { pushSignalIssuer } from "@/lib/waits/store";
import {
  domainEvents,
  projectTokens,
  runs,
  runWaitDeliveries,
  runPublicationObservations,
  taskComments,
  taskRelations,
} from "@/lib/db/schema";
import { projectWaitSignalGrant } from "@/lib/waits/authority";
import { waitConditionSchema } from "@/lib/waits/manifest";

export const WAIT_RUN_FACTS = {
  "run.done": "done",
  "run.failed": "failed",
  "run.review": "review",
  "run.review_opened": "review",
  "run.crashed": "crashed",
  "run.abandoned": "abandoned",
} as const;

type RunFactKind = keyof typeof WAIT_RUN_FACTS;
const runFactKinds = Object.keys(WAIT_RUN_FACTS) as RunFactKind[];

type ObservedFact = Omit<WaitResult, "schemaVersion" | "resolvedAt">;

type RelatedRun = Pick<
  typeof runs.$inferSelect,
  "id" | "projectId" | "taskId" | "parentRunId"
>;

export async function isRelatedWaitRun(
  tx: WaitTx,
  owner: RelatedRun,
  target: RelatedRun,
  selector: { relation?: "parent" | "child"; relation_id?: string },
): Promise<boolean> {
  if (
    owner.projectId === null ||
    owner.projectId !== target.projectId ||
    owner.id === target.id
  )
    return false;
  if (selector.relation === "parent") return owner.parentRunId === target.id;
  if (selector.relation === "child") return target.parentRunId === owner.id;
  if (!selector.relation_id || !owner.taskId || !target.taskId) return false;

  const [relation] = await tx
    .select({ id: taskRelations.id })
    .from(taskRelations)
    .where(
      and(
        eq(taskRelations.id, selector.relation_id),
        eq(taskRelations.projectId, owner.projectId),
        eq(taskRelations.fromTaskId, owner.taskId),
        eq(taskRelations.toTaskId, target.taskId),
      ),
    );

  return relation !== undefined;
}

/** Read committed canonical facts under the wait's resolution lock. */
export async function readObservedWaitFact(
  tx: WaitTx,
  wait: WaitRow,
  observedHeadSha?: string,
): Promise<ObservedFact | null> {
  if (!wait.sourceTargetId || !wait.deadlineAt) return null;

  if (wait.conditionKind === "signal") {
    if (wait.bindingHeadSha) {
      if (!observedHeadSha) return null;
      if (observedHeadSha !== wait.bindingHeadSha)
        return {
          source: "head",
          sourceId: wait.id,
          outcome: "stale",
          data: { boundHeadSha: wait.bindingHeadSha, observedHeadSha },
        };
    }

    return readTrustedWaitDelivery(tx, wait);
  }

  if (wait.conditionKind === "ci" || wait.conditionKind === "pr")
    return readProviderWaitFact(tx, wait);

  const { timeoutSeconds: _timeoutSeconds, ...parameters } =
    wait.condition.parameters;
  const condition = waitConditionSchema.parse({
    kind: wait.conditionKind,
    ...parameters,
  });

  if (condition.kind === "comment" && wait.registrationSnapshot) {
    const [comment] = await tx
      .select({ id: taskComments.id, eventId: domainEvents.id })
      .from(domainEvents)
      .innerJoin(
        taskComments,
        and(
          eq(taskComments.projectId, domainEvents.projectId),
          eq(taskComments.taskId, domainEvents.taskId),
          sql`${taskComments.id} = ${domainEvents.payload}->>'commentId'`,
          eq(taskComments.actorType, domainEvents.actorType),
          sql`${taskComments.actorId} IS NOT DISTINCT FROM ${domainEvents.actorId}`,
        ),
      )
      .where(
        and(
          eq(domainEvents.kind, "task.comment_added"),
          eq(domainEvents.projectId, wait.projectId),
          eq(domainEvents.taskId, wait.sourceTargetId),
          sql`${domainEvents.occurredAt} < ${wait.deadlineAt}`,
          sql`NOT pg_visible_in_snapshot(${domainEvents.txId}, ${wait.registrationSnapshot}::pg_snapshot)`,
          condition.actor
            ? and(
                eq(taskComments.actorType, condition.actor.type),
                eq(taskComments.actorId, condition.actor.id),
              )
            : undefined,
        ),
      )
      .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id))
      .limit(1);

    return comment
      ? {
          source: "comment",
          sourceId: String(comment.eventId),
          outcome: "commented",
          data: { commentId: comment.id },
        }
      : null;
  }

  if (condition.kind !== "run") return null;

  const owners = await tx
    .select({
      id: runs.id,
      projectId: runs.projectId,
      taskId: runs.taskId,
      parentRunId: runs.parentRunId,
    })
    .from(runs)
    .where(
      and(
        inArray(runs.id, [wait.runId, wait.sourceTargetId]),
        eq(runs.projectId, wait.projectId),
        isNull(runs.companyId),
      ),
    );
  const owner = owners.find(({ id }) => id === wait.runId);
  const target = owners.find(({ id }) => id === wait.sourceTargetId);

  if (
    !owner ||
    !target ||
    !(await isRelatedWaitRun(tx, owner, target, condition))
  )
    return null;

  const [settled] = await tx
    .select({ id: domainEvents.id, kind: domainEvents.kind })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.projectId, wait.projectId),
        eq(domainEvents.runId, target.id),
        inArray(domainEvents.kind, runFactKinds),
        sql`${domainEvents.occurredAt} < ${wait.deadlineAt}`,
      ),
    )
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id))
    .limit(1);

  if (!settled || !(settled.kind in WAIT_RUN_FACTS)) return null;

  return {
    source: "run",
    sourceId: String(settled.id),
    outcome: WAIT_RUN_FACTS[settled.kind as RunFactKind],
    data: { runId: target.id },
  };
}

async function readTrustedWaitDelivery(
  tx: WaitTx,
  wait: WaitRow,
): Promise<ObservedFact | null> {
  if (!wait.deadlineAt) return null;
  const issuer = pushSignalIssuer(wait);
  const [delivery] = await tx
    .select({ id: runWaitDeliveries.id, body: runWaitDeliveries.body })
    .from(runWaitDeliveries)
    .where(
      and(
        eq(runWaitDeliveries.waitId, wait.id),
        eq(runWaitDeliveries.application, "pending"),
        wait.bindingHeadSha
          ? sql`${runWaitDeliveries.body}->>'headSha' = ${wait.bindingHeadSha}`
          : undefined,
        sql`${runWaitDeliveries.receivedAt} < ${wait.deadlineAt}`,
        or(
          eq(runWaitDeliveries.sourceKind, "operator"),
          and(
            eq(runWaitDeliveries.sourceKind, "project_token"),
            issuer === undefined
              ? undefined
              : issuer === null
                ? sql`false`
                : eq(runWaitDeliveries.sourceId, issuer),
            sql`EXISTS (
              SELECT 1 FROM ${projectTokens}
              WHERE ${projectWaitSignalGrant(wait.projectId, sql`${runWaitDeliveries.sourceId}`)}
            )`,
          ),
        ),
      ),
    )
    .orderBy(asc(runWaitDeliveries.receivedAt), asc(runWaitDeliveries.id))
    .limit(1);

  return delivery
    ? {
        source: "signal",
        sourceId: delivery.id,
        outcome: delivery.body.outcome,
        ...(delivery.body.payload === undefined
          ? {}
          : { data: delivery.body.payload }),
      }
    : null;
}

async function readProviderWaitFact(
  tx: WaitTx,
  wait: WaitRow,
): Promise<ObservedFact | null> {
  if (!wait.publicationId || !wait.deadlineAt || !wait.bindingHeadSha)
    return null;
  const scope = and(
    eq(runPublicationObservations.publicationId, wait.publicationId),
    eq(runPublicationObservations.projectId, wait.projectId),
    eq(runPublicationObservations.runId, wait.runId),
    sql`${runPublicationObservations.fact}->>'waitId' = ${wait.id}`,
    sql`${runPublicationObservations.observedAt} < ${wait.deadlineAt}`,
  );
  const latest = async (kind: "ref" | "ci" | "pr") => {
    const [observation] = await tx
      .select()
      .from(runPublicationObservations)
      .where(and(scope, eq(runPublicationObservations.kind, kind)))
      .orderBy(
        desc(runPublicationObservations.observedAt),
        desc(runPublicationObservations.id),
      )
      .limit(1);

    return observation;
  };

  if (wait.conditionKind === "ci") {
    const ref = await latest("ref");

    if (!ref) return null;
    if (ref.headSha !== wait.bindingHeadSha)
      return {
        source: "provider",
        sourceId: ref.id,
        outcome: "stale",
        data: {
          observedHeadSha: ref.headSha,
          boundHeadSha: wait.bindingHeadSha,
        },
      };
    if (wait.condition.parameters.transport === "push")
      return readTrustedWaitDelivery(tx, wait);
  }

  if (wait.conditionKind !== "ci" && wait.conditionKind !== "pr") return null;
  const observed = await latest(wait.conditionKind);
  const data = observed?.fact;

  if (
    !observed ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof data.outcome !== "string" ||
    !wait.condition.outcomes.includes(data.outcome)
  )
    return null;

  return {
    source: "provider",
    sourceId: observed.id,
    outcome: data.outcome,
    data,
  };
}
