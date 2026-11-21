import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { normalizePublicationOrigin } from "../../../runtime/workspace-publication";
import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import {
  projects,
  runAutonomousDecisions,
  runAutonomousReversals,
  runs,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { notifyAutonomousDecisionChanged } from "@/lib/runs/peek-wake";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { readProviderPublicationHead } from "@/lib/waits/ci-provider";
import { encodeWaitDigest } from "@/lib/waits/store";
import { verifyDeliveredCommitReversal } from "@/lib/worktree";

const log = pino({
  name: "autonomous-reversals",
  level: process.env.LOG_LEVEL ?? "info",
});

export const reversalBody = z.strictObject({
  revertSha: z.string().regex(GIT_OBJECT_ID),
});
const prList = z
  .array(z.object({ number: z.number().int().positive() }))
  .max(10);
const mergedPr = z.object({
  merged: z.literal(true),
  merged_at: z.iso.datetime({ offset: true }),
  merge_commit_sha: z.string().regex(GIT_OBJECT_ID),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
  merged_by: z.object({
    id: z.number().int().positive(),
    login: z.string(),
    type: z.literal("User"),
  }),
});

function notVerified(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The provider and target history did not verify a human reversal",
    {
      details: { reason: "autonomy_reversal_unverified" },
    },
  );
}

async function readGithubReversal(
  input: { repository: string; targetBranch: string; revertSha: string },
  fetchPage: typeof fetch,
) {
  const token = process.env.GH_TOKEN?.trim();

  if (!token) throw notVerified();
  const parts = input.repository.split("/").map(encodeURIComponent).join("/");
  const endpoint = `https://api.github.com/repos/${parts}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  async function read(
    path: string,
  ): Promise<{ value: unknown; paginated: boolean }> {
    const result = await fetchPage(`${endpoint}${path}`, {
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      cache: "no-store",
    });

    if (!result.ok)
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Could not verify the reversal with GitHub",
        {
          details: {
            status: result.status,
            reason: "autonomy_reversal_unverified",
          },
        },
      );

    return {
      value: await readBoundedJson(result, 128 * 1024),
      paginated: result.headers.get("link")?.includes('rel="next"') ?? false,
    };
  }
  const list = await read(`/commits/${input.revertSha}/pulls?per_page=10`);
  const candidates = prList.safeParse(list.value);

  if (!candidates.success || list.paginated || candidates.data.length !== 1)
    throw notVerified();
  const number = candidates.data[0].number;
  const proof = mergedPr.safeParse((await read(`/pulls/${number}`)).value);

  if (
    !proof.success ||
    proof.data.merge_commit_sha !== input.revertSha ||
    proof.data.base.ref !== input.targetBranch ||
    proof.data.base.repo.full_name.toLowerCase() !==
      input.repository.toLowerCase() ||
    proof.data.merged_by.login.endsWith("[bot]")
  )
    throw notVerified();
  const targetHead = await readProviderPublicationHead(
    {
      provider: "github",
      apiBase: "https://api.github.com",
      token,
      repository: input.repository,
      headSha: input.revertSha,
      ref: `refs/heads/${input.targetBranch}`,
    },
    fetchPage,
  );

  return {
    targetHead,
    actorId: String(proof.data.merged_by.id),
    number,
    reversedAt: new Date(proof.data.merged_at),
  };
}

export async function recordAutonomousReversal(
  db: Db,
  input: {
    runId: string;
    projectId: string;
    decisionId: string;
    reporterId: string;
    revertSha: string;
  },
  fetchPage: typeof fetch = fetch,
): Promise<{ receiptId: string; created: boolean }> {
  const scope = and(
    eq(runAutonomousDecisions.id, input.decisionId),
    eq(runAutonomousDecisions.runId, input.runId),
    eq(runAutonomousDecisions.projectId, input.projectId),
    eq(runAutonomousDecisions.phase, "observed"),
  );
  const [owner] = await db
    .select({
      decision: runAutonomousDecisions,
      grant: runs.flowPublicationGrant,
      project: projects,
    })
    .from(runAutonomousDecisions)
    .innerJoin(runs, eq(runs.id, runAutonomousDecisions.runId))
    .innerJoin(projects, eq(projects.id, runAutonomousDecisions.projectId))
    .where(scope);
  const witness = owner?.decision.witness;
  const deliveredCommit = witness?.deliveredCommit;
  const grant = owner?.grant;

  if (
    !owner ||
    owner.decision.action === "fail" ||
    !grant ||
    owner.project.archivedAt ||
    typeof deliveredCommit !== "string" ||
    !GIT_OBJECT_ID.test(deliveredCommit) ||
    !owner.project.repoUrl ||
    normalizePublicationOrigin(owner.project.repoUrl) !== grant.repoIdentity ||
    !/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(grant.repoIdentity)
  )
    throw notVerified();
  const receiptId = encodeWaitDigest([input.decisionId, input.revertSha]);
  const [existing] = await db
    .select({ id: runAutonomousReversals.id })
    .from(runAutonomousReversals)
    .where(eq(runAutonomousReversals.id, receiptId));

  if (existing) return { receiptId, created: false };
  const provider = await readGithubReversal(
    {
      repository: grant.repoIdentity.slice("github.com/".length),
      targetBranch: grant.targetBranch,
      revertSha: input.revertSha,
    },
    fetchPage,
  );

  if (
    provider.reversedAt < owner.decision.createdAt ||
    !(await verifyDeliveredCommitReversal({
      projectRepoPath: owner.project.repoPath,
      deliveredCommit,
      revertCommit: input.revertSha,
      targetHead: provider.targetHead,
    }))
  )
    throw notVerified();

  const created = await db.transaction(async (tx) => {
    await assertTaskLaunchUserAuthority(tx, input.projectId, input.reporterId, [
      "promoteRun",
    ]);
    const [record] = await tx
      .insert(runAutonomousReversals)
      .values({
        id: receiptId,
        projectId: input.projectId,
        runId: input.runId,
        decisionId: input.decisionId,
        reportedBy: input.reporterId,
        providerActorId: provider.actorId,
        providerPrNumber: provider.number,
        deliveredCommit,
        revertCommit: input.revertSha,
        reversedAt: provider.reversedAt,
      })
      .onConflictDoNothing({ target: runAutonomousReversals.id })
      .returning({ id: runAutonomousReversals.id });

    if (record) {
      await emitDomainEvent({
        db: tx,
        kind: "run.autonomous_decision",
        projectId: input.projectId,
        runId: input.runId,
        actor: { type: "user", id: input.reporterId },
        payload: {
          schemaVersion: 1,
          decisionId: input.decisionId,
          reversalId: receiptId,
        },
      });
      await notifyAutonomousDecisionChanged(tx, input.runId);
    }

    return record !== undefined;
  });

  if (created)
    log.info(
      { runId: input.runId, receiptId, providerActorId: provider.actorId },
      "autonomous reversal verified",
    );

  return { receiptId, created };
}
