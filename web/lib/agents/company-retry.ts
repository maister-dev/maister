import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { AgentRetryOptions } from "./retry-preparation";
import type { CompanyAgentRetryRecipe } from "./retry-types";
import type { CompanyAgentContextInput } from "./company-agent-context";
import type { CompanyFlowContextInput } from "./company-flow-context";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { companyExecutionSnapshotSchema } from "./company-execution-types";
import { prepareCompanyAgentReplacementContext } from "./company-agent-context";
import { reserveCompanyAgentReplacement } from "./company-agent-launch";
import { prepareCompanyFlowReplacementContext } from "./company-flow-context";
import { reserveCompanyFlowReplacement } from "./company-flow-launch";
import { authorizeCompanyCronReplacementSource } from "./company-trigger-reservation";
import { buildOperationalContract } from "./launch-contract";
import { parseAgentRetryRecipe } from "./retry-snapshot";
import { RETRY_PREVIEW_WINDOW_MS } from "./retry-preparation";
import { runnerCatalogEntry } from "./runner-catalog";
import {
  preDispatchRetrySafetyReason,
  retryQuiescenceReason,
  retryDigest,
  retryRefusal,
} from "./retry-guards";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import {
  authorizeRunKnowledgeDisclosure,
  authorizeRunsKnowledgeDisclosure,
} from "@/lib/brain/knowledge-run-disclosure";
import {
  agentRetryIntents,
  platformAcpRunners,
  runs,
  runSessions,
} from "@/lib/db/schema";
import { snapshotRunner } from "@/lib/acp-runners/resolve";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { localHost } from "@/lib/execution-host/resolver";
import { assignmentBudgetAllowsDispatchSql } from "@/lib/specialist-assignments/delegated-budget";
import { compileManifest } from "@/lib/flows/graph/compile";
import {
  pgErrorOf,
  queryErrorDiagnostics,
  redactQueryError,
} from "@/lib/db/pg-error";

const log = pino({
  name: "company-agent-retry",
  level: process.env.LOG_LEVEL ?? "info",
});

type Intent = typeof agentRetryIntents.$inferSelect;
type Replacement = CompanyAgentRetryRecipe & {
  replacement: NonNullable<CompanyAgentRetryRecipe["replacement"]>;
};
type ReplacementPreparation = { recipe: Replacement } & (
  | { kind: "agent"; request: CompanyAgentContextInput }
  | { kind: "flow"; request: CompanyFlowContextInput; sessionsSha256: string }
);

function companyRetryFailure(sourceRunId: string, error: unknown): never {
  const pg = pgErrorOf(error);

  log.warn(
    { sourceRunId, ...queryErrorDiagnostics(error) },
    "company specialist retry refused",
  );
  if (pg?.code === "55P03") throw retryRefusal("retry_assignment_busy");
  if (
    pg?.constraint === "company_retry_replacement_reference" ||
    pg?.constraint === "company_retry_replacement_successor"
  )
    throw retryRefusal("retry_context_changed");
  throw redactQueryError(error);
}

function replacementRecipe(intent: Intent): Replacement {
  const recipe = parseAgentRetryRecipe(intent.recipe);

  if (
    recipe.version !== 3 ||
    !recipe.replacement ||
    intent.companyId !== recipe.owner.companyId
  )
    throw retryRefusal("company_retry_runtime_unavailable");

  return { ...recipe, replacement: recipe.replacement };
}

function replacementPreview(
  recipe: CompanyAgentRetryRecipe,
  userId: string,
  now: number,
) {
  const bucket = Math.floor(now / RETRY_PREVIEW_WINDOW_MS);

  return {
    previewFingerprint: retryDigest({ recipe, userId, bucket }),
    expiresAt: new Date((bucket + 1) * RETRY_PREVIEW_WINDOW_MS).toISOString(),
  };
}

async function authorizeRetainedCompanyRetry(
  tx: Db,
  intent: Intent,
  userId: string,
): Promise<Replacement> {
  const recipe = replacementRecipe(intent);

  await authorizeCompanyUserAction(
    tx,
    userId,
    recipe.owner.companyId,
    "assignments:recover",
  );
  const runIds = intent.createdRunId
    ? [intent.sourceRunId, intent.createdRunId]
    : [intent.sourceRunId];

  // Review and lifecycle writers may hold one of these rows before entering
  // the assignment. Yield instead of waiting while holding the source Run.
  await tx
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.id, runIds))
    .orderBy(runs.id)
    .for("share", { noWait: true });
  await tx.execute(sql`SELECT id FROM specialist_assignments
    WHERE id=${recipe.assignment.id} AND company_id=${recipe.owner.companyId}
    FOR SHARE NOWAIT`);
  await authorizeRunsKnowledgeDisclosure(tx, { kind: "user", userId }, runIds);

  return recipe;
}

export async function authorizeCompanyRetryReceipt(
  db: Db,
  intent: Intent,
  userId: string,
): Promise<void> {
  await db
    .transaction((tx) => authorizeRetainedCompanyRetry(tx, intent, userId))
    .catch((error: unknown) => companyRetryFailure(intent.sourceRunId, error));
}

async function prepareReplacement(
  tx: Db,
  source: Run,
  userId: string,
): Promise<ReplacementPreparation> {
  const captured = companyExecutionSnapshotSchema.safeParse(
    source.companyExecutionSnapshot,
  );

  if (!captured.success || source.companyId !== captured.data.owner.companyId)
    throw retryRefusal("retry_source_unavailable");
  const snapshot = captured.data;
  const graph = snapshot.schemaVersion === 2;
  const cron = source.triggerSource === "cron";

  await authorizeCompanyUserAction(
    tx,
    userId,
    snapshot.owner.companyId,
    "assignments:recover",
  );
  await tx.execute(sql`SELECT id FROM specialist_assignments
    WHERE id=${snapshot.assignment.id} AND company_id=${snapshot.owner.companyId}
    FOR NO KEY UPDATE NOWAIT`);
  await authorizeRunKnowledgeDisclosure(
    tx,
    { kind: "user", userId },
    source.id,
  );
  if (
    (graph
      ? source.runKind !== "flow"
      : source.runKind !== "agent" || source.agentKind !== "operational") ||
    source.agentWorkspace !== "none" ||
    source.parentRunId ||
    source.persistent ||
    (source.triggerSource !== "manual" && !cron) ||
    (cron && source.retryOfRunId !== null) ||
    !source.resultContract ||
    !source.endedAt
  )
    throw retryRefusal("retry_source_unsupported");
  if (cron) await authorizeCompanyCronReplacementSource(tx, source.id, userId);
  const reason = graph
    ? await retryQuiescenceReason(tx, source)
    : await preDispatchRetrySafetyReason(tx, source);

  if (reason) throw retryRefusal(reason);
  const [head] = (
    await tx.execute(sql`
    SELECT subject.revision,subject.input_revision,subject.context_revision,owner.epoch,
      task_launch_admission_digest(source.result_contract) AS result_sha256,
      company_retry_source_digest(source) AS source_sha256,
      CASE WHEN source.run_kind='flow' THEN company_flow_retry_has_dispatch_witness(source.id)
        ELSE company_retry_has_dispatch_witness(source.id) END AS before_dispatch,
      CASE WHEN source.run_kind='flow' THEN company_flow_retry_sessions_digest(source.id) END AS sessions_sha256,
      specialist_current_root_id(subject.id,subject.input_revision) AS current_root,
      specialist_other_unsettled_root(subject.id, ${source.id}) AS other_branch,
      ${assignmentBudgetAllowsDispatchSql(sql`${source.id}`)} AS budget_allowed
    FROM specialist_assignments subject JOIN runs source ON source.id=${source.id}
    JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=${source.id}
      AND owner.placement_id=${source.executionAssignmentId}
    WHERE subject.id=${snapshot.assignment.id} AND subject.company_id=${snapshot.owner.companyId}
    FOR SHARE OF owner
  `)
  ).rows;
  const sessions = await tx
    .select({
      runner: runSessions.runnerSnapshot,
      name: runSessions.sessionName,
    })
    .from(runSessions)
    .where(eq(runSessions.runId, source.id))
    .orderBy(runSessions.sessionName)
    .for("share");

  if (
    !head ||
    head.current_root !== source.id ||
    head.other_branch !== false ||
    typeof head.revision !== "number" ||
    typeof head.context_revision !== "number" ||
    typeof head.epoch !== "number" ||
    typeof head.result_sha256 !== "string" ||
    typeof head.source_sha256 !== "string" ||
    head.input_revision !== snapshot.assignment.inputRevision ||
    sessions.length === 0
  )
    throw retryRefusal("retry_context_changed");
  if (head.budget_allowed !== true)
    throw retryRefusal("assignment_budget_exhausted");
  if (head.before_dispatch !== true)
    throw retryRefusal("reconciliation_required");
  const request: CompanyAgentContextInput = {
    companyId: snapshot.owner.companyId,
    assignmentId: snapshot.assignment.id,
    assignmentRevision: head.revision,
    inputRevision: snapshot.assignment.inputRevision,
    bindingId: snapshot.specialistBinding.id,
    bindingRevision: snapshot.specialistBinding.revision,
    triggerSource: cron ? "cron" : "manual",
  };
  const flowRequest = graph
    ? {
        ...request,
        coordinatorBindingId: snapshot.coordinatorFlowBinding.id,
        coordinatorBindingRevision: snapshot.coordinatorFlowBinding.revision,
      }
    : undefined;
  const flow = flowRequest
    ? await prepareCompanyFlowReplacementContext(tx, userId, flowRequest)
    : null;
  const context =
    flow ?? (await prepareCompanyAgentReplacementContext(tx, userId, request));
  const declared = flow
    ? [...compileManifest(flow.coordinator.snapshot.manifest).sessions.keys()]
    : [];
  const primary = declared.includes("default")
    ? "default"
    : (declared[0] ?? "default");
  const session = sessions.find((item) => item.name === primary);

  if (!session?.runner) throw retryRefusal("retry_runner_unavailable");
  for (const entry of sessions) {
    if (!entry.runner) throw retryRefusal("retry_runner_unavailable");
    const [runner] = await tx
      .select()
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, entry.runner.id))
      .for("share");

    if (
      !runner?.enabled ||
      runner.readinessStatus !== "Ready" ||
      retryDigest(
        JSON.parse(JSON.stringify(snapshotRunner(runnerCatalogEntry(runner)))),
      ) !== retryDigest(entry.runner)
    )
      throw retryRefusal("retry_runner_unavailable");
  }

  if (
    context.input.digest !== snapshot.assignment.inputSha256 ||
    context.binding.snapshotDigest !==
      snapshot.specialistBinding.snapshotSha256 ||
    (graph &&
      flow?.coordinator.snapshotDigest !==
        snapshot.coordinatorFlowBinding.snapshotSha256) ||
    retryDigest(
      flow?.resultContract ?? buildOperationalContract(context.effective),
    ) !== retryDigest(source.resultContract) ||
    retryDigest(source.scheduledRequestSnapshot) !==
      retryDigest(context.input.snapshot.scheduledRequest)
  )
    throw retryRefusal("retry_context_changed");
  const replacement = {
    sourceRunId: source.id,
    assignmentRevision: head.revision,
    contextRevision: head.context_revision,
    ownerEpoch: head.epoch,
    resultSha256: head.result_sha256,
    sourceSha256: head.source_sha256,
    ...(graph && typeof head.sessions_sha256 === "string"
      ? { sessionsSha256: head.sessions_sha256 }
      : {}),
  };
  const recipe: Replacement = {
    version: 3,
    strategy: "pre_work_retry",
    owner: snapshot.owner,
    projectId: null,
    taskId: null,
    taskRevision: null,
    project: null,
    agentId: context.effective.parsed.id,
    definition: context.effective,
    configuration: context.binding.snapshot.effectiveConfiguration,
    trigger: { source: request.triggerSource, eventId: null, payload: null },
    runner: session.runner,
    policy: context.binding.snapshot.executionPolicy,
    contextDigest: retryDigest(replacement),
    specialistBinding: snapshot.specialistBinding,
    coordinatorFlowBinding: graph ? snapshot.coordinatorFlowBinding : null,
    assignment: snapshot.assignment,
    replacement,
    ...(context.input.snapshot.scheduledRequest
      ? { scheduledRequestSnapshot: context.input.snapshot.scheduledRequest }
      : {}),
  };

  parseAgentRetryRecipe(recipe);

  if (flowRequest) {
    if (!replacement.sessionsSha256)
      throw retryRefusal("retry_runner_unavailable");

    return {
      kind: "flow",
      request: flowRequest,
      recipe,
      sessionsSha256: replacement.sessionsSha256,
    };
  }

  return { kind: "agent", request, recipe };
}

export async function companyAgentRetryOptions(
  db: Db,
  source: Run,
  userId: string,
): Promise<AgentRetryOptions> {
  const { recipe, intent } = await db
    .transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, source.id))
        .for("no key update");

      if (!current) throw retryRefusal("retry_source_unavailable");
      const [intent] = await tx
        .select()
        .from(agentRetryIntents)
        .where(
          and(
            eq(agentRetryIntents.sourceRunId, source.id),
            eq(agentRetryIntents.state, "launched"),
            sql`${agentRetryIntents.recipe} ? 'replacement'`,
          ),
        );

      if (intent) {
        const recipe = await authorizeRetainedCompanyRetry(tx, intent, userId);

        return { recipe, intent };
      }
      const { recipe } = await prepareReplacement(tx, current, userId);

      return { recipe, intent: null };
    })
    .catch((error: unknown) => companyRetryFailure(source.id, error));
  const runnerId = recipe.runner.id;

  return {
    eligible: !intent,
    reason: intent ? "retry_successor_already_owned" : null,
    strategy: "pre_work_retry",
    qualificationOptIn: false,
    ...replacementPreview(recipe, userId, Date.now()),
    existingIntentId: intent?.id ?? null,
    sourceRunnerId: runnerId,
    selectedRunnerId: runnerId,
    runners: [
      { id: runnerId, label: recipe.runner.model, ready: true, reason: null },
    ],
    differences: [],
  };
}

/** Persist the recipe and successor together. The existing scheduler owns the resulting Pending Run. */
export async function acceptCompanyAgentRetry(
  db: Db,
  source: Run,
  userId: string,
  request: Readonly<{
    requestKey: string;
    runnerId: string;
    previewFingerprint: string;
  }>,
  requestDigest: string,
): Promise<Intent> {
  if (!source.companyId) throw retryRefusal("retry_source_unavailable");
  await authorizeCompanyUserAction(
    db,
    userId,
    source.companyId,
    "assignments:recover",
  );
  const hosts = createExecutionHosts({ db });
  const host = await localHost({ db, transport: hosts.transport });
  const actorIdentity = `user:${userId}`;

  return db
    .transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, source.id))
        .for("no key update");
      const [replay] = await tx
        .select()
        .from(agentRetryIntents)
        .where(
          and(
            eq(agentRetryIntents.actorIdentity, actorIdentity),
            eq(agentRetryIntents.requestKey, request.requestKey),
          ),
        );

      if (replay) {
        if (
          replay.sourceRunId !== source.id ||
          replay.requestDigest !== requestDigest
        )
          throw retryRefusal("retry_request_key_reused");
        await authorizeRetainedCompanyRetry(tx, replay, userId);

        return replay;
      }
      if (!current) throw retryRefusal("retry_source_unavailable");
      const prepared = await prepareReplacement(tx, current, userId);
      const { recipe } = prepared;

      if (
        request.runnerId !== recipe.runner.id ||
        request.previewFingerprint !==
          replacementPreview(recipe, userId, Date.now()).previewFingerprint
      )
        throw retryRefusal("retry_preview_stale");
      const successorRunId = randomUUID();
      const [intent] = await tx
        .insert(agentRetryIntents)
        .values({
          sourceRunId: source.id,
          companyId: recipe.owner.companyId,
          sourceAgentId: recipe.agentId,
          actorIdentity,
          actorUserId: userId,
          requestKey: request.requestKey,
          requestDigest,
          selectedRunnerId: request.runnerId,
          recipe,
          previewFingerprint: request.previewFingerprint,
          successorRunId,
        })
        .onConflictDoNothing()
        .returning();

      if (!intent) throw retryRefusal("retry_successor_already_owned");
      if (prepared.kind === "flow")
        await reserveCompanyFlowReplacement(
          tx,
          userId,
          prepared.request,
          {
            runId: successorRunId,
            sourceRunId: source.id,
            sessionsSha256: prepared.sessionsSha256,
          },
          hosts,
          host,
        );
      else
        await reserveCompanyAgentReplacement(
          tx,
          userId,
          prepared.request,
          {
            runId: successorRunId,
            sourceRunId: source.id,
            runnerSha256: retryDigest(recipe.runner),
          },
          hosts,
          host,
        );
      const [launched] = await tx
        .update(agentRetryIntents)
        .set({
          state: "launched",
          createdRunId: successorRunId,
          updatedAt: new Date(),
        })
        .where(eq(agentRetryIntents.id, intent.id))
        .returning();

      if (!launched) throw retryRefusal("retry_acceptance_lost");
      log.info(
        {
          sourceRunId: source.id,
          retryIntentId: intent.id,
          successorRunId,
          assignmentId: recipe.assignment.id,
          ownerEpoch: recipe.replacement.ownerEpoch,
        },
        "company specialist replacement reserved",
      );

      return launched;
    })
    .catch((error: unknown) => companyRetryFailure(source.id, error));
}
