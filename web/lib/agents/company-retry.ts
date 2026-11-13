import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { AgentRetryOptions } from "./retry-preparation";
import type { CompanyAgentRetryRecipe } from "./retry-types";
import type { CompanyAgentContextInput } from "./company-agent-context";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { companyAgentExecutionSnapshotSchema } from "./company-agent-execution-types";
import { prepareCompanyAgentReplacementContext } from "./company-agent-context";
import { reserveCompanyAgentReplacement } from "./company-agent-launch";
import { buildOperationalContract } from "./launch-contract";
import { parseAgentRetryRecipe } from "./retry-snapshot";
import { RETRY_PREVIEW_WINDOW_MS } from "./retry-preparation";
import { runnerCatalogEntry } from "./runner-catalog";
import {
  preDispatchRetrySafetyReason,
  retryDigest,
  retryRefusal,
} from "./retry-guards";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
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

export async function authorizeCompanyRetryReceipt(
  db: Db,
  intent: Intent,
  userId: string,
): Promise<Replacement> {
  const recipe = replacementRecipe(intent);

  await authorizeCompanyUserAction(
    db,
    userId,
    recipe.owner.companyId,
    "assignments:recover",
  );
  await authorizeRunKnowledgeDisclosure(
    db,
    { kind: "user", userId },
    intent.sourceRunId,
  );
  if (intent.createdRunId)
    await authorizeRunKnowledgeDisclosure(
      db,
      { kind: "user", userId },
      intent.createdRunId,
    );

  return recipe;
}

async function prepareReplacement(
  tx: Db,
  source: Run,
  userId: string,
): Promise<{ request: CompanyAgentContextInput; recipe: Replacement }> {
  const captured = companyAgentExecutionSnapshotSchema.safeParse(
    source.companyExecutionSnapshot,
  );

  if (!captured.success || source.companyId !== captured.data.owner.companyId)
    throw retryRefusal("retry_source_unavailable");
  const snapshot = captured.data;

  await authorizeCompanyUserAction(
    tx,
    userId,
    snapshot.owner.companyId,
    "assignments:recover",
  );
  await authorizeRunKnowledgeDisclosure(
    tx,
    { kind: "user", userId },
    source.id,
  );
  if (
    source.runKind !== "agent" ||
    source.agentKind !== "operational" ||
    source.agentWorkspace !== "none" ||
    source.parentRunId ||
    source.persistent ||
    source.triggerSource !== "manual" ||
    !source.resultContract ||
    !source.endedAt
  )
    throw retryRefusal("retry_source_unsupported");
  const reason = await preDispatchRetrySafetyReason(tx, source);

  if (reason) throw retryRefusal(reason);
  const [head] = (
    await tx.execute(sql`
    SELECT subject.revision,subject.input_revision,subject.context_revision,owner.epoch,
      task_launch_admission_digest(source.result_contract) AS result_sha256,
      company_retry_source_digest(source) AS source_sha256,
      company_retry_has_dispatch_witness(source.id) AS before_dispatch,
      specialist_current_root_id(subject.id,subject.input_revision) AS current_root,
      specialist_other_unsettled_root(subject.id, ${source.id}) AS other_branch,
      ${assignmentBudgetAllowsDispatchSql(sql`${source.id}`)} AS budget_allowed
    FROM specialist_assignments subject JOIN runs source ON source.id=${source.id}
    JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=${source.id}
      AND owner.placement_id=${source.executionAssignmentId}
    WHERE subject.id=${snapshot.assignment.id} AND subject.company_id=${snapshot.owner.companyId}
    FOR NO KEY UPDATE OF subject
  `)
  ).rows;
  const [session] = await tx
    .select({ runner: runSessions.runnerSnapshot })
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, source.id),
        eq(runSessions.sessionName, "default"),
      ),
    )
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
    !session?.runner
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
    triggerSource: "manual",
  };
  const context = await prepareCompanyAgentReplacementContext(
    tx,
    userId,
    request,
  );
  const [runner] = await tx
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, session.runner.id))
    .for("share");

  if (
    !runner?.enabled ||
    runner.readinessStatus !== "Ready" ||
    retryDigest(
      JSON.parse(JSON.stringify(snapshotRunner(runnerCatalogEntry(runner)))),
    ) !== retryDigest(session.runner)
  )
    throw retryRefusal("retry_runner_unavailable");

  if (
    context.input.digest !== snapshot.assignment.inputSha256 ||
    context.binding.snapshotDigest !==
      snapshot.specialistBinding.snapshotSha256 ||
    retryDigest(buildOperationalContract(context.effective)) !==
      retryDigest(source.resultContract) ||
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
    trigger: { source: "manual", eventId: null, payload: null },
    runner: session.runner,
    policy: context.binding.snapshot.executionPolicy,
    contextDigest: retryDigest(replacement),
    specialistBinding: snapshot.specialistBinding,
    coordinatorFlowBinding: null,
    assignment: snapshot.assignment,
    replacement,
    ...(context.input.snapshot.scheduledRequest
      ? { scheduledRequestSnapshot: context.input.snapshot.scheduledRequest }
      : {}),
  };

  parseAgentRetryRecipe(recipe);

  return { request, recipe };
}

export async function companyAgentRetryOptions(
  db: Db,
  source: Run,
  userId: string,
): Promise<AgentRetryOptions> {
  const { recipe, intent } = await db.transaction(async (tx) => {
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
      const recipe = await authorizeCompanyRetryReceipt(tx, intent, userId);

      return { recipe, intent };
    }
    const { recipe } = await prepareReplacement(tx, current, userId);

    return { recipe, intent: null };
  });
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
  await authorizeRunKnowledgeDisclosure(
    db,
    { kind: "user", userId },
    source.id,
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
        await authorizeCompanyRetryReceipt(tx, replay, userId);

        return replay;
      }
      if (!current) throw retryRefusal("retry_source_unavailable");
      const { recipe, request: admission } = await prepareReplacement(
        tx,
        current,
        userId,
      );

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
      await reserveCompanyAgentReplacement(
        tx,
        userId,
        admission,
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
    .catch((error: unknown) => {
      const { constraint } = pgErrorOf(error) ?? {};

      log.warn(
        { sourceRunId: source.id, ...queryErrorDiagnostics(error) },
        "company specialist replacement refused",
      );
      if (
        constraint === "company_retry_replacement_reference" ||
        constraint === "company_retry_replacement_successor"
      )
        throw retryRefusal("retry_context_changed");
      throw redactQueryError(error);
    });
}
