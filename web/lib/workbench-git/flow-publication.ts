import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { LoadedProjectRun } from "@/lib/flows/graph/runner-core";
import type { PrResult } from "@/lib/runs/pr-adapter";

import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { configuredPrCredential } from "../../../runtime/pull-request";
import { detectProvider } from "../../../runtime/repository-url";
import { normalizePublicationOrigin } from "../../../runtime/workspace-publication";

import { assertNativeProjectPublication } from "@/lib/brain/knowledge-project-publication";
import {
  executionAssignments,
  nodeAttempts,
  projects,
  runPublications,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  assertFlowDriverClaim,
  type FlowDriverClaim,
} from "@/lib/flows/graph/driver-claim";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { pullRequestDefaults } from "@/lib/workbench-git/pull-request";
import {
  recordPublished,
  recordPullRequestOpened,
  resolvePublishName,
} from "@/lib/workbench-git/publication";
import { closingReferenceForRun } from "@/lib/tasks/external-source/service";
import { reserveCiCallbacks } from "@/lib/waits/reservations";
import { flowPublicationGrantSchema } from "@/lib/workbench-git/flow-publication-grant";
import {
  claimLifecycleOperation,
  finalizeLifecycleOperation,
  renewLifecycleOperationLease,
} from "@/lib/workbench-lifecycle/service";

const log = pino({
  name: "flow-publication",
  level: process.env.LOG_LEVEL ?? "info",
});

type Publication = typeof runPublications.$inferSelect;
type PublishInput = {
  db: Db;
  loaded: LoadedProjectRun;
  client: BoundClient;
  driver: FlowDriverClaim;
  nodeAttemptId: string;
  nodeId: string;
  remote: string;
  pr: Publication["prMode"];
};

function changed(runId: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Flow publication no longer owns the current attempt and assignment",
    {
      details: { runId, reason: "assignment_fenced" },
    },
  );
}

function forbidden(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Flow publication authority is unavailable or its approved destination changed",
    {
      details: { reason: "flow_publication_grant_required" },
    },
  );
}

function authorizePublication(
  input: PublishInput,
  run: Pick<
    typeof runs.$inferSelect,
    "flowPublicationGrant" | "flowRevisionId"
  >,
  project: typeof projects.$inferSelect,
): string {
  const grant = flowPublicationGrantSchema.safeParse(run.flowPublicationGrant);
  const target = input.loaded.workspace.targetBranch ?? project.mainBranch;

  if (
    !grant.success ||
    project.archivedAt ||
    input.remote !== "origin" ||
    grant.data.flowRevisionId !== run.flowRevisionId ||
    target !== grant.data.targetBranch ||
    grant.data.branchTemplate !== project.publicBranchTemplate ||
    !project.repoUrl ||
    normalizePublicationOrigin(project.repoUrl) !== grant.data.repoIdentity
  ) {
    throw forbidden();
  }

  return grant.data.repoIdentity;
}

async function lockPublishAttempt(tx: Db, input: PublishInput): Promise<void> {
  await assertFlowDriverClaim(tx, input.driver);
  const { run } = input.loaded;
  const [owner] = await tx
    .select({
      run: {
        flowPublicationGrant: runs.flowPublicationGrant,
        flowRevisionId: runs.flowRevisionId,
      },
      project: projects,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .innerJoin(
      executionAssignments,
      and(
        eq(executionAssignments.id, runs.executionAssignmentId),
        eq(executionAssignments.runId, runs.id),
      ),
    )
    .innerJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.runId, runs.id),
        eq(nodeAttempts.nodeId, runs.currentStepId),
      ),
    )
    .where(
      and(
        eq(runs.id, run.id),
        eq(runs.projectId, run.projectId),
        eq(runs.status, "Running"),
        eq(executionAssignments.id, input.client.assignment.id),
        eq(executionAssignments.state, "active"),
        eq(nodeAttempts.id, input.nodeAttemptId),
        eq(nodeAttempts.nodeType, "publish"),
        eq(nodeAttempts.status, "Running"),
        eq(nodeAttempts.executionAssignmentId, input.client.assignment.id),
      ),
    )
    .for("update", { of: [runs, projects] });

  if (!owner) throw changed(run.id);
  authorizePublication(input, owner.run, owner.project);
}

/** Phase-separated publication reuses the workbench's name and observed writer. */
export async function publishFlowBranch(
  input: PublishInput,
): Promise<Publication> {
  const { db, loaded } = input;
  const { run, workspace, task } = loaded;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId));

  if (!project)
    throw new MaisterError("PRECONDITION", "Flow publication has no project");
  const repoIdentity = authorizePublication(input, run, project);

  await assertNativeProjectPublication(() => db, run);

  const id = createHash("sha256")
    .update(`flow-publication:${input.nodeAttemptId}`)
    .digest("hex");
  const [existing] = await db
    .select()
    .from(runPublications)
    .where(eq(runPublications.id, id));

  if (existing?.phase === "observed") return existing;
  const branch =
    existing?.headRef.slice("refs/heads/".length) ??
    resolvePublishName({
      runId: run.id,
      internalBranch: workspace.branch,
      remote: input.remote,
      requested: null,
      template: project.publicBranchTemplate,
      taskKey: `${project.taskKey}-${task.number}`,
      taskTitle: task.title,
      recordedBranch: workspace.publishedBranch,
      recordedRemote: workspace.publishedRemote,
      legacyPrHead: Boolean(workspace.prUrl && !workspace.publishedBranch),
      upstream: null,
    }).name;
  const headRef = `refs/heads/${branch}`;
  const targetBranch = workspace.targetBranch ?? project.mainBranch;

  if (branch === targetBranch || branch === project.mainBranch)
    throw forbidden();

  const claim = await claimLifecycleOperation({
    database: db,
    runId: run.id,
    workspaceId: workspace.id,
    operation: "exportBranch",
    expectedRunStatus: "Running",
    replay: {
      attemptId: id,
      assertOwner: (tx) => lockPublishAttempt(tx, input),
    },
  });
  const ownership = {
    database: db,
    workspaceId: workspace.id,
    attemptId: claim.attemptId,
  };

  try {
    const receipt =
      existing ??
      (await reservePublication(
        input,
        id,
        headRef,
        `refs/heads/${targetBranch}`,
        repoIdentity,
      ));

    return await applyPublication(input, {
      receipt,
      project,
      repoIdentity,
      branch,
      targetBranch,
      attemptId: claim.attemptId,
    });
  } catch (error) {
    try {
      await db.transaction(async (tx) => {
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, ownership.workspaceId))
          .for("update");
        await assertFlowDriverClaim(tx, input.driver);
        await finalizeLifecycleOperation({
          ...ownership,
          database: tx,
          state: "failed",
        });
      });
    } catch (releaseError) {
      log.warn(
        {
          err: releaseError,
          runId: run.id,
          workspaceId: workspace.id,
          attemptId: claim.attemptId,
        },
        "Flow publication claim release failed",
      );
    }
    throw error;
  }
}

async function applyPublication(
  input: PublishInput,
  publication: {
    receipt: Publication;
    project: typeof projects.$inferSelect;
    repoIdentity: string;
    branch: string;
    targetBranch: string;
    attemptId: string;
  },
): Promise<Publication> {
  const {
    db,
    loaded: { run, task, workspace },
    client,
  } = input;
  const { receipt, project, repoIdentity, branch, targetBranch, attemptId } =
    publication;
  const ownership = { database: db, workspaceId: workspace.id, attemptId };

  if (
    receipt.assignmentId !== client.assignment.id ||
    receipt.phase !== "claimed" ||
    receipt.flowRevision !== run.flowRevision
  )
    throw changed(run.id);
  if (
    receipt.repoIdentity !== repoIdentity ||
    receipt.baseRef !== `refs/heads/${targetBranch}`
  )
    throw forbidden();
  await db.transaction((tx) => lockPublishAttempt(tx, input));
  await renewLifecycleOperationLease(ownership);
  const remote = await client.workspacePublication({
    action: "push",
    remote: receipt.remoteName,
    headRef: receipt.headRef,
    expectedHead: receipt.sourceHead,
    expectedRemoteHead: receipt.expectedRemoteHead,
    repoIdentity: receipt.repoIdentity,
  });

  if (
    remote.remoteHeadSha !== receipt.sourceHead ||
    remote.repoIdentity !== receipt.repoIdentity
  )
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The exact publication effect could not be observed",
    );

  let pr: PrResult | null = null;

  if (input.pr !== "none") {
    await db.transaction((tx) => lockPublishAttempt(tx, input));
    await renewLifecycleOperationLease(ownership);
    const defaults = pullRequestDefaults({
      run,
      internalBranch: workspace.branch,
      sourceBranch: branch,
      targetBranch,
      taskKey: `${project.taskKey}-${task.number}`,
      taskTitle: task.title,
      origin: process.env.MAISTER_API_BASE_URL ?? "",
      closingReference: await closingReferenceForRun(db, run, project),
    });

    if (!project.repoUrl) throw forbidden();
    const credential = configuredPrCredential(detectProvider(project.repoUrl));
    const observed = await client.workspacePublication({
      action: "open_pr",
      remote: receipt.remoteName,
      headRef: receipt.headRef,
      baseRef: receipt.baseRef,
      expectedHead: receipt.sourceHead,
      repoIdentity: receipt.repoIdentity,
      title: defaults.title,
      body: defaults.body,
      draft: input.pr === "draft",
      ...(credential ? { credential } : {}),
    });

    if (
      !observed.pullRequest ||
      observed.repoIdentity !== receipt.repoIdentity ||
      observed.headSha !== receipt.sourceHead ||
      observed.remoteHeadSha !== receipt.sourceHead
    )
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "The exact publication PR effect could not be observed",
      );
    pr = observed.pullRequest;
  }

  return db.transaction(async (tx) => {
    await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
      .for("update");
    await lockPublishAttempt(tx, input);

    const observedAt = new Date();
    const fence = { kind: "lifecycle" as const, attemptId };

    await recordPublished({
      database: tx,
      workspaceId: workspace.id,
      branch,
      remote: receipt.remoteName,
      at: observedAt,
      fence,
    });

    if (pr) {
      if (
        !(await recordPullRequestOpened({
          database: tx,
          workspaceId: workspace.id,
          attemptId,
          operation: "exportBranch",
          pr,
          targetBranch,
        }))
      )
        throw changed(run.id);
    } else {
      await finalizeLifecycleOperation({
        ...ownership,
        database: tx,
        state: "done",
      });
    }

    const [published] = await tx
      .update(runPublications)
      .set({
        phase: "observed",
        observedAt,
        observedHead: receipt.sourceHead,
        prUrl: pr?.url ?? null,
        prNumber: pr?.number ?? null,
      })
      .where(
        and(
          eq(runPublications.id, receipt.id),
          eq(runPublications.phase, "claimed"),
        ),
      )
      .returning();

    if (!published) throw changed(run.id);

    await emitDomainEvent({
      db: tx,
      kind: "run.publication_observed",
      projectId: run.projectId,
      runId: run.id,
      actor: { type: "system", id: null },
      occurredAt: observedAt,
      payload: { schemaVersion: 1, publicationId: published.id },
    });

    return published;
  });
}

async function reservePublication(
  input: PublishInput,
  id: string,
  headRef: string,
  baseRef: string,
  repoIdentity: string,
): Promise<Publication> {
  const {
    db,
    client,
    loaded: { run, workspace },
  } = input;
  const observed = await client.workspacePublication({
    remote: input.remote,
    headRef,
    action: "inspect",
  });

  if (observed.repoIdentity !== repoIdentity) throw forbidden();

  return db.transaction(async (tx) => {
    await lockPublishAttempt(tx, input);

    const [prior] = await tx
      .select()
      .from(runPublications)
      .where(eq(runPublications.id, id));

    if (prior) return prior;
    const [last] = await tx
      .select({ generation: runPublications.generation })
      .from(runPublications)
      .where(eq(runPublications.runId, run.id))
      .orderBy(desc(runPublications.generation))
      .limit(1);
    const [receipt] = await tx
      .insert(runPublications)
      .values({
        id,
        runId: run.id,
        projectId: run.projectId,
        workspaceId: workspace.id,
        nodeAttemptId: input.nodeAttemptId,
        operationKey: id,
        flowRevision: run.flowRevision,
        assignmentId: client.assignment.id,
        remoteName: input.remote,
        repoIdentity: observed.repoIdentity,
        generation: (last?.generation ?? 0) + 1,
        headRef,
        baseRef,
        sourceHead: observed.headSha,
        expectedRemoteHead: observed.remoteHeadSha,
        prMode: input.pr,
        phase: "claimed",
      })
      .returning();

    await reserveCiCallbacks(
      tx,
      receipt,
      input.nodeId,
      input.loaded.manifest.nodes,
    );

    return receipt;
  });
}
