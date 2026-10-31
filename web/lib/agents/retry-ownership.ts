import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  AgentRetryClaim,
  AgentRetryRecipe,
  AgentRetryAllocation,
} from "@/lib/agents/retry-types";

import { and, eq } from "drizzle-orm";

import {
  agentRetryIntents,
  runs,
  tasks,
  agents,
  agentProjectLinks,
  packageInstalls,
  projectPackageAttachments,
  platformAcpRunners,
  projects,
} from "@/lib/db/schema";
import {
  assertRetryAuthority,
  retrySafetyReason,
  retryRefusal,
  retryDigest,
} from "@/lib/agents/retry-guards";
import { resolveAgentConfig } from "@/lib/agents/config";
import { resolveAgentLaunchExecutionPolicy } from "@/lib/agents/execution-policy";
import { runnerCatalogEntry } from "@/lib/agents/runner-catalog";
import { snapshotRunner } from "@/lib/acp-runners/resolve";

/** Final source→task→intent lock order, reused before allocation and the atomic successor insertion. */
export async function assertAgentRetryClaim(
  db: Db,
  claim: AgentRetryClaim,
): Promise<typeof agentRetryIntents.$inferSelect> {
  const [candidate] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId));

  if (!candidate) throw retryRefusal("retry_intent_unavailable");
  const [source] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, candidate.sourceRunId))
    .for("update");

  if (!source) throw retryRefusal("retry_source_unavailable");
  const [task] = candidate.recipe.taskId
    ? await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, candidate.recipe.taskId))
        .for("update")
    : [];
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId))
    .for("update");

  if (
    intent.state !== "accepted" ||
    intent.leaseOwner !== claim.owner ||
    intent.leaseFence !== claim.fence ||
    !intent.leaseExpiresAt ||
    intent.leaseExpiresAt.getTime() <= Date.now()
  )
    throw retryRefusal("retry_owner_stale");
  if (!intent.actorUserId) throw retryRefusal("retry_authority_revoked");
  await assertRetryAuthority(db, intent.projectId, intent.actorUserId);
  const reason = await retrySafetyReason(db, source);

  if (reason) throw retryRefusal(reason);
  if (
    intent.recipe.taskId &&
    (!task ||
      task.qualificationInputRevision !== intent.recipe.taskRevision ||
      task.status !== "Backlog" ||
      task.triageStatus === "triaged")
  )
    throw retryRefusal("retry_task_changed");
  await assertRetryRecipeCurrent(db, intent.recipe);

  return intent;
}

/** Only database state is read under lifecycle locks; package bytes were validated before this transaction. */
export async function assertRetryRecipeCurrent(
  db: Db,
  recipe: AgentRetryRecipe,
): Promise<void> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, recipe.projectId));
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, recipe.agentId));
  const [link] = await db
    .select()
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.projectId, recipe.projectId),
        eq(agentProjectLinks.agentId, recipe.agentId),
      ),
    );
  const [attachment] = await db
    .select({ install: packageInstalls })
    .from(projectPackageAttachments)
    .innerJoin(
      packageInstalls,
      eq(packageInstalls.id, projectPackageAttachments.packageInstallId),
    )
    .where(
      and(
        eq(projectPackageAttachments.projectId, recipe.projectId),
        eq(
          projectPackageAttachments.packageName,
          recipe.definition.packageName,
        ),
      ),
    );
  const [runner] = await db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, recipe.runner.id));

  if (
    !project ||
    project.archivedAt ||
    !agent?.enabled ||
    agent.quarantinedAt ||
    !link?.enabled ||
    !attachment ||
    attachment.install.id !== recipe.definition.packageInstallId ||
    attachment.install.packageStatus !== "Installed" ||
    !["trusted", "trusted_by_policy"].includes(
      attachment.install.trustStatus,
    ) ||
    attachment.install.resolvedRevision !==
      recipe.definition.resolvedRevision ||
    !runner?.enabled ||
    runner.readinessStatus !== "Ready"
  )
    throw retryRefusal("retry_context_changed");
  const policy = resolveAgentLaunchExecutionPolicy({
    instanceOverride: link.executionPolicyOverride,
    recommended: recipe.definition.parsed.recommended?.executionPolicy,
    projectDefault: project.executionPolicyDefault,
  });
  const config = resolveAgentConfig(
    recipe.definition.parsed.config,
    link.config,
  );

  if (
    retryDigest(snapshotRunner(runnerCatalogEntry(runner))) !==
      retryDigest(recipe.runner) ||
    retryDigest(config) !== retryDigest(recipe.configuration) ||
    retryDigest(policy) !== retryDigest(recipe.policy) ||
    retryDigest({
      mainBranch: project.mainBranch,
      branchPrefix: project.branchPrefix,
      branchBase: link.branchBase ?? null,
    }) !== retryDigest(recipe.project)
  )
    throw retryRefusal("retry_context_changed");
}

export async function armAgentRetryAllocation(
  db: Db,
  claim: AgentRetryClaim,
  resource: AgentRetryAllocation["resources"][number],
): Promise<void> {
  await db.transaction(async (tx) => {
    const intent = await assertAgentRetryClaim(tx, claim);

    if (intent.allocation) {
      if (retryDigest(intent.allocation.resources) !== retryDigest([resource]))
        throw retryRefusal("retry_resource_conflict");

      return;
    }
    await tx
      .update(agentRetryIntents)
      .set({
        allocation: {
          version: 1,
          generation: claim.fence,
          resources: [resource],
          disposition: "armed",
          revision: 1,
          attempts: 0,
          dueAt: new Date().toISOString(),
          errorCode: null,
        },
        updatedAt: new Date(),
      })
      .where(eq(agentRetryIntents.id, intent.id));
  });
}

export async function recordAgentRetrySuccessor(
  db: Db,
  claim: AgentRetryClaim,
  runId: string,
): Promise<void> {
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId));

  if (!intent || intent.successorRunId !== runId)
    throw retryRefusal("retry_successor_mismatch");
  const updated = await db
    .update(agentRetryIntents)
    .set({
      state: "launched",
      createdRunId: runId,
      leaseOwner: null,
      leaseExpiresAt: null,
      allocation: intent.allocation
        ? {
            ...intent.allocation,
            disposition: "released",
            revision: intent.allocation.revision + 1,
          }
        : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentRetryIntents.id, claim.intentId),
        eq(agentRetryIntents.leaseOwner, claim.owner),
        eq(agentRetryIntents.leaseFence, claim.fence),
      ),
    )
    .returning({ id: agentRetryIntents.id });

  if (updated.length !== 1) throw retryRefusal("retry_owner_stale");
}

export async function frozenRetryDefinition(
  db: Db,
  runId: string,
): Promise<AgentRetryRecipe["definition"] | null> {
  const [intent] = await db
    .select({ recipe: agentRetryIntents.recipe })
    .from(agentRetryIntents)
    .where(
      and(
        eq(agentRetryIntents.createdRunId, runId),
        eq(agentRetryIntents.state, "launched"),
      ),
    );

  return intent?.recipe.definition ?? null;
}
