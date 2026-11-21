import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run, Workspace } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { WorkspacePublicationSnapshot } from "../../../runtime/workspace-publication";
import type {
  CompletionEvidence,
  MergedPullRequestEvidence,
} from "./completion-evidence";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import {
  completionGrantSchema,
  type EnabledCompletionSettings,
} from "./completion-policy";

import {
  artifactInstances,
  domainEvents,
  gateResults,
  projectTokens,
  runPublicationObservations,
  runPublications,
  runWaitDeliveries,
  runWaits,
} from "@/lib/db/schema";
import {
  getNodeAttemptsForRun,
  latestAttemptByNode,
} from "@/lib/flows/graph/ledger";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { projectWaitSignalGrant } from "@/lib/waits/authority";
import { PR_STATE_SCAN_CADENCE_SECONDS } from "@/lib/scheduler/jobs";

export const COMPLETION_CI_FRESHNESS_MS = PR_STATE_SCAN_CADENCE_SECONDS * 2_000;

export async function observeCompletionCandidate(
  db: Db,
  run: Run,
  workspace: Workspace,
  hosts?: Pick<ExecutionHosts, "forAssignment">,
): Promise<WorkspacePublicationSnapshot | null> {
  if (!run.executionAssignmentId || !workspace.targetBranch) return null;
  const executionHosts =
    hosts ??
    (await import("@/lib/execution-host/client")).createExecutionHosts({ db });
  const client = await executionHosts.forAssignment({
    id: run.executionAssignmentId,
  });

  return client.workspacePublication({
    action: "evidence",
    remote: "origin",
    headRef: `refs/heads/${workspace.targetBranch}`,
  });
}

export async function readCompletionEvidence(input: {
  db: Db;
  run: Run;
  workspace: Workspace;
  observed: WorkspacePublicationSnapshot | null;
  currentLimits: EnabledCompletionSettings;
  now: Date;
}): Promise<CompletionEvidence | null> {
  const { db, run, workspace, observed, currentLimits, now } = input;
  const grant = completionGrantSchema.safeParse(run.autonomousCompletionGrant);
  const projectId = run.projectId;

  if (
    !grant.success ||
    grant.data.flowRevisionId !== run.flowRevisionId ||
    !projectId ||
    !observed?.evidence ||
    observed.repoIdentity !== run.flowPublicationGrant?.repoIdentity ||
    workspace.targetBranch !== run.flowPublicationGrant?.targetBranch
  )
    return null;
  const [reviewEvent] = await db
    .select({ cause: sql<unknown>`${domainEvents.payload}->>'cause'` })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.kind, "run.review_opened"),
        eq(domainEvents.runId, run.id),
        eq(domainEvents.projectId, projectId),
      ),
    )
    .orderBy(desc(domainEvents.id))
    .limit(1);

  if (reviewEvent?.cause !== "graph_completed") return null;
  const loaded = await loadRunManifest(run.id, db);
  const declaration = grant.data.declaration;
  const ciNode = loaded?.compatible
    ? loaded.manifest.nodes.find((node) => node.id === declaration.ci)
    : undefined;

  if (ciNode?.type !== "wait" || ciNode.on.kind !== "ci") return null;
  const ci = ciNode.on;
  const attempts = latestAttemptByNode(await getNodeAttemptsForRun(run.id, db));
  const waitAttempt = attempts.get(declaration.ci);
  const pubAttempt = attempts.get(ci.publication);

  if (waitAttempt?.status !== "Succeeded" || pubAttempt?.status !== "Succeeded")
    return null;
  const [publication] = await db
    .select()
    .from(runPublications)
    .where(
      and(
        eq(runPublications.runId, run.id),
        eq(runPublications.projectId, projectId),
        eq(runPublications.phase, "observed"),
      ),
    )
    .orderBy(desc(runPublications.generation))
    .limit(1);

  if (
    !publication ||
    publication.nodeAttemptId !== pubAttempt.id ||
    publication.sourceHead !== observed.headSha ||
    publication.observedHead !== observed.headSha ||
    publication.flowRevision !== run.flowRevision ||
    publication.repoIdentity !== observed.repoIdentity ||
    publication.baseRef !== `refs/heads/${workspace.targetBranch}` ||
    publication.headRef !== `refs/heads/${workspace.publishedBranch}` ||
    publication.remoteName !== workspace.publishedRemote
  )
    return null;
  let mergedPr: MergedPullRequestEvidence | undefined;

  if (run.deliveryPolicySnapshot?.strategy === "pull_request") {
    if (
      !publication.prUrl ||
      !publication.prNumber ||
      publication.prUrl !== workspace.prUrl ||
      publication.prNumber !== workspace.prNumber ||
      !loaded?.compatible
    )
      return null;
    const prNodes = loaded.manifest.nodes.filter(
      (node) =>
        node.type === "wait" &&
        node.on.kind === "pr" &&
        node.on.publication === ci.publication,
    );
    const prAttempts = prNodes.flatMap((node) => {
      const attempt = attempts.get(node.id);

      return attempt?.status === "Succeeded" ? [attempt.id] : [];
    });

    if (prAttempts.length !== 1) return null;
    const [prWait] = await db
      .select()
      .from(runWaits)
      .where(
        and(
          eq(runWaits.nodeAttemptId, prAttempts[0]),
          eq(runWaits.publicationId, publication.id),
          eq(runWaits.projectId, projectId),
          eq(runWaits.runId, run.id),
          eq(runWaits.conditionKind, "pr"),
        ),
      );
    const [prObservation] = await db
      .select()
      .from(runPublicationObservations)
      .where(
        and(
          eq(runPublicationObservations.publicationId, publication.id),
          eq(runPublicationObservations.kind, "pr"),
          sql`${runPublicationObservations.fact}->>'waitId' = ${prWait?.id ?? null}`,
        ),
      )
      .orderBy(
        desc(runPublicationObservations.observedAt),
        desc(runPublicationObservations.id),
      )
      .limit(1);
    const fact = prObservation?.fact;

    if (
      prWait?.resumeState !== "applied" ||
      prWait.result?.source !== "provider" ||
      prWait.result.outcome !== "merged" ||
      prObservation?.headSha !== observed.headSha ||
      !fact ||
      typeof fact !== "object" ||
      Array.isArray(fact) ||
      fact.outcome !== "merged" ||
      fact.prNumber !== publication.prNumber ||
      typeof fact.mergeCommitSha !== "string" ||
      !GIT_OBJECT_ID.test(fact.mergeCommitSha)
    )
      return null;
    mergedPr = {
      url: publication.prUrl,
      number: publication.prNumber,
      mergeCommit: fact.mergeCommitSha,
      observationId: prObservation.id,
    };
  }
  const [wait] = await db
    .select()
    .from(runWaits)
    .where(
      and(
        eq(runWaits.nodeAttemptId, waitAttempt.id),
        eq(runWaits.runId, run.id),
        eq(runWaits.projectId, projectId),
        eq(runWaits.publicationId, publication.id),
      ),
    );
  const [artifact] = await db
    .select({ id: artifactInstances.id })
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.id, `wait-result:${waitAttempt.id}`),
        eq(artifactInstances.runId, run.id),
        eq(artifactInstances.kind, "wait-result"),
        eq(artifactInstances.validity, "current"),
        sql`(${artifactInstances.locator}->>'text')::jsonb->>'resultDigest' = ${wait?.resultDigest ?? null}`,
      ),
    );

  const lastCiProof =
    wait?.providerVerifiedAt ?? (mergedPr ? wait?.resolvedAt : null);

  if (
    !artifact ||
    wait?.result?.outcome !== "success" ||
    wait.state !== "resolved" ||
    wait.resumeState !== "applied" ||
    wait.flowRevision !== run.flowRevision ||
    wait.bindingHeadSha !== observed.headSha ||
    !lastCiProof ||
    now.getTime() - lastCiProof.getTime() > COMPLETION_CI_FRESHNESS_MS
  )
    return null;
  const anchor = {
    head: observed.headSha,
    base: observed.evidence.baseSha,
    revision: grant.data.flowRevisionId,
    generation: publication.id,
  };
  const [{ headSha: verifiedRef } = { headSha: "" }] = await db
    .select({ headSha: runPublicationObservations.headSha })
    .from(runPublicationObservations)
    .where(
      and(
        eq(runPublicationObservations.publicationId, publication.id),
        eq(runPublicationObservations.kind, "ref"),
        sql`${runPublicationObservations.fact}->>'waitId' = ${wait.id}`,
      ),
    )
    .orderBy(
      desc(runPublicationObservations.observedAt),
      desc(runPublicationObservations.id),
    )
    .limit(1);

  if (verifiedRef !== anchor.head) return null;
  let checks: unknown;

  if (ci.transport === "pull" && wait.result.source === "provider") {
    const [latest] = await db
      .select()
      .from(runPublicationObservations)
      .where(
        and(
          eq(runPublicationObservations.publicationId, publication.id),
          eq(runPublicationObservations.kind, "ci"),
          sql`${runPublicationObservations.fact}->>'waitId' = ${wait.id}`,
        ),
      )
      .orderBy(
        desc(runPublicationObservations.observedAt),
        desc(runPublicationObservations.id),
      )
      .limit(1);

    const fact = latest?.fact;

    if (
      latest?.headSha !== anchor.head ||
      !fact ||
      typeof fact !== "object" ||
      Array.isArray(fact) ||
      fact.outcome !== "success" ||
      fact.issuer !== ci.issuer
    )
      return null;
    checks = fact.requiredChecks;
  } else if (ci.transport === "push" && wait.result.source === "signal") {
    const [delivery] = await db
      .select({ body: runWaitDeliveries.body })
      .from(runWaitDeliveries)
      .innerJoin(
        projectTokens,
        projectWaitSignalGrant(projectId, sql`${runWaitDeliveries.sourceId}`),
      )
      .where(
        and(
          eq(runWaitDeliveries.id, wait.result.sourceId),
          eq(runWaitDeliveries.waitId, wait.id),
          eq(runWaitDeliveries.sourceKind, "project_token"),
          eq(runWaitDeliveries.sourceId, ci.issuer),
          eq(runWaitDeliveries.application, "applied"),
        ),
      );
    const payload = delivery?.body.payload;

    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return null;
    checks = payload.passedChecks;
  }
  if (
    !Array.isArray(checks) ||
    !checks.every((name): name is string => typeof name === "string")
  )
    return null;
  const references = [...declaration.gates, declaration.review];
  const gateAttempts = references.map((reference) =>
    attempts.get(reference.node),
  );

  if (
    gateAttempts.some(
      (attempt) =>
        attempt?.status !== "Succeeded" ||
        attempt.completionGitAnchor?.state !== "verified",
    )
  )
    return null;
  const gateRows = await db
    .select()
    .from(gateResults)
    .where(
      and(
        eq(gateResults.runId, run.id),
        inArray(
          gateResults.nodeAttemptId,
          gateAttempts.flatMap((attempt) => (attempt ? [attempt.id] : [])),
        ),
      ),
    )
    .orderBy(desc(gateResults.createdAt), desc(gateResults.id));
  const findGate = (reference: typeof declaration.review) => {
    const attempt = attempts.get(reference.node);
    const row = gateRows.find(
      (candidate) =>
        candidate.nodeAttemptId === attempt?.id &&
        candidate.gateId === reference.gate,
    );

    return row && attempt?.completionGitAnchor
      ? {
          ...anchor,
          ...reference,
          attemptId: attempt.id,
          ...attempt.completionGitAnchor,
          status: row.status,
          mode: row.mode,
          verdict: row.verdict,
          kind: row.kind,
        }
      : null;
  };
  const review = findGate(declaration.review);

  return {
    anchor,
    currentLimits,
    launchLimits: grant.data.bounds,
    required: { ...declaration, checks: ci.checks },
    gates: declaration.gates.flatMap((reference) => {
      const gate = findGate(reference);

      return gate &&
        gate.kind !== "human_review" &&
        gate.kind !== "external_check"
        ? [gate]
        : [];
    }),
    review: review?.kind === "ai_judgment" ? review : null,
    ci: {
      ...anchor,
      node: declaration.ci,
      attemptId: waitAttempt.id,
      issuer: ci.issuer,
      checks,
      outcome: "success",
      source: wait.result.source,
      current: true,
      sourceVerified: true,
    },
    diff: {
      ...anchor,
      clean: observed.evidence.clean,
      complete: true,
      dependenciesVerified: false,
      files: observed.evidence.files,
    },
    ...(mergedPr ? { mergedPr } : {}),
  };
}
