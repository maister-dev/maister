import "server-only";

import type { DeliveryDiffStat, RepoDeliveryRef } from "@/lib/db/schema";
import type { Provider } from "@/lib/repo-source";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { type TimestampedDeliveryHistoryCommit } from "@/lib/delivery-history-core";
import { cleanDeliveryStats } from "@/lib/delivery-pathspec";
import { MaisterError } from "@/lib/errors";
import { detectProvider } from "@/lib/repo-source";
import {
  resolvePullRequestTarget,
  type PullRequestTargetLookup,
} from "@/lib/scheduler/handlers/repo-delivery-pr-history";
import {
  fetchRemote,
  firstParentDeliveryHistory,
  getRemoteUrl,
  remoteTrackingBranchHead,
} from "@/lib/worktree";
import {
  MaisterProvenanceError,
  parseMaisterTrailers,
} from "@/lib/worktree-provenance-core";

export const REPO_DELIVERY_WINDOW_DAYS = 365;

const ORIGIN_REMOTE = "origin";
const DAY_MS = 24 * 60 * 60 * 1_000;

const log = pino({
  name: "repo-delivery-scan",
  level: process.env.LOG_LEVEL ?? "info",
});

type QueryResult = { rows?: unknown[] };

type RepoDeliveryScanDb = {
  execute(query: SQL): Promise<QueryResult>;
  transaction<T>(
    transaction: (tx: RepoDeliveryScanDb) => Promise<T>,
  ): Promise<T>;
};

type ProjectRow = {
  id: string;
  repo_path: string;
  provider: string | null;
  main_branch: string;
  archived_at: Date | string | null;
};

type PullRequestRunRow = {
  run_id: string;
  pr_number: number;
};

type ResolvedPullRequestRun = {
  runId: string;
  prNumber: number;
  targetSha: string;
  diffStat: DeliveryDiffStat;
};

type PullRequestAttribution = {
  prNumberBySha: ReadonlyMap<string, number>;
  resolvedRuns: readonly ResolvedPullRequestRun[];
  providerComplete: boolean;
};

type Bucket = {
  bucketStart: Date;
  bucketEnd: Date;
  commits: number;
  mergePrUnits: number;
  additions: number;
  deletions: number;
  deliveryRefs: RepoDeliveryRef[];
};

export type RepoDeliveryScanSummary = {
  projectId: string;
  branch: string;
  headSha: string;
  bucketCount: number;
  commits: number;
  additions: number;
  deletions: number;
  fetchedAt: Date;
};

export async function runRepoDeliveryScanJob(input: {
  projectId: string | null;
  now?: Date;
  db?: RepoDeliveryScanDb;
  prHistoryLookup?: PullRequestTargetLookup;
}): Promise<RepoDeliveryScanSummary> {
  if (!input.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      "repo_delivery_scan job requires a project_id",
    );
  }

  const now = input.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw new MaisterError("CONFIG", "repo_delivery_scan now must be a date");
  }

  const db = input.db ?? (getDb() as unknown as RepoDeliveryScanDb);
  const project = await loadProject(db, input.projectId);

  if (project.archived_at !== null) {
    throw new MaisterError(
      "PRECONDITION",
      `repo_delivery_scan project is archived: ${project.id}`,
    );
  }

  const origin = await getRemoteUrl({
    projectRepoPath: project.repo_path,
    name: ORIGIN_REMOTE,
  });

  if (origin === null) {
    throw new MaisterError(
      "PRECONDITION",
      `repo_delivery_scan origin remote is not configured: ${project.id}`,
    );
  }

  await fetchRemote({
    projectRepoPath: project.repo_path,
    name: ORIGIN_REMOTE,
  });

  const headSha = await remoteTrackingBranchHead({
    projectRepoPath: project.repo_path,
    remote: ORIGIN_REMOTE,
    branch: project.main_branch,
  });

  if (headSha === null) {
    throw new MaisterError(
      "PRECONDITION",
      `repo_delivery_scan origin target is missing: ${project.main_branch}`,
    );
  }

  const history = await firstParentDeliveryHistory({
    projectRepoPath: project.repo_path,
    headRef: `refs/remotes/${ORIGIN_REMOTE}/${project.main_branch}`,
    since: windowStart(now),
  });
  const pullRequestAttribution = await resolvePullRequestAttribution({
    db,
    project,
    origin,
    history,
    lookup: input.prHistoryLookup ?? resolvePullRequestTarget,
  });
  const buckets = bucketHistory(
    history,
    now,
    pullRequestAttribution.prNumberBySha,
  );

  await replaceProjectRollups({
    db,
    projectId: project.id,
    expectedBranch: project.main_branch,
    buckets,
    fetchedAt: now,
    headSha,
    providerComplete: pullRequestAttribution.providerComplete,
    resolvedPullRequestRuns: pullRequestAttribution.resolvedRuns,
  });

  const summary = summarize({
    projectId: project.id,
    branch: project.main_branch,
    headSha,
    buckets,
    fetchedAt: now,
  });

  log.info(summary, "repo delivery scan cache replaced");

  return summary;
}

async function loadProject(
  db: RepoDeliveryScanDb,
  projectId: string,
): Promise<ProjectRow> {
  const result = await db.execute(sql`
    SELECT id, repo_path, provider, main_branch, archived_at
    FROM projects
    WHERE id = ${projectId}
    LIMIT 1
  `);
  const project = rowsOf<ProjectRow>(result)[0];

  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `repo_delivery_scan project does not exist: ${projectId}`,
    );
  }

  return project;
}

async function resolvePullRequestAttribution(input: {
  db: RepoDeliveryScanDb;
  project: ProjectRow;
  origin: string;
  history: readonly TimestampedDeliveryHistoryCommit[];
  lookup: PullRequestTargetLookup;
}): Promise<PullRequestAttribution> {
  const candidates = rowsOf<PullRequestRunRow>(
    await input.db.execute(sql`
      SELECT run.id AS run_id, workspace.pr_number
      FROM runs AS run
      INNER JOIN workspaces AS workspace ON workspace.run_id = run.id
      WHERE run.project_id = ${input.project.id}
        AND workspace.project_id = ${input.project.id}
        AND workspace.target_branch = ${input.project.main_branch}
        AND workspace.promotion_state = 'done'
        AND workspace.promoted_at IS NOT NULL
        AND workspace.pr_number IS NOT NULL
        AND run.promoted_head_sha IS NOT NULL
        AND run.diff_stat IS NULL
    `),
  );

  if (candidates.length === 0) {
    return {
      prNumberBySha: new Map(),
      resolvedRuns: [],
      providerComplete: true,
    };
  }

  const byPrNumber = new Map<number, PullRequestRunRow[]>();

  for (const candidate of candidates) {
    const entries = byPrNumber.get(candidate.pr_number) ?? [];

    entries.push(candidate);
    byPrNumber.set(candidate.pr_number, entries);
  }

  const provider = resolvedProvider(input.project.provider, input.origin);
  const historyBySha = new Map(
    input.history.map((commit) => [commit.sha, commit] as const),
  );
  const proposals: ResolvedPullRequestRun[] = [];
  let providerComplete = true;

  for (const [prNumber, runs] of byPrNumber) {
    if (runs.length !== 1) {
      providerComplete = false;
      continue;
    }

    const resolution = await input.lookup({
      provider,
      repoPath: input.project.repo_path,
      prNumber,
      remoteUrl: input.origin,
    });

    if (resolution.state === "unmerged") continue;

    if (resolution.state !== "resolved") {
      providerComplete = false;
      continue;
    }

    const commit = historyBySha.get(resolution.targetSha);

    if (!commit) {
      // A provider response becomes attribution evidence only once its SHA is
      // present in the freshly fetched target history. Never infer from title
      // or subject text when that proof is absent. A resolved PR outside this
      // rolling horizon cannot change this cache or its current ratio.
      log.debug(
        {
          projectId: input.project.id,
          prNumber,
          targetSha: resolution.targetSha,
        },
        "[FIX:pr-horizon] resolved PR target is outside fetched history",
      );
      continue;
    }

    proposals.push({
      runId: runs[0].run_id,
      prNumber,
      targetSha: commit.sha,
      diffStat: cleanDeliveryStats(commit.files),
    });
  }

  const byTargetSha = new Map<string, ResolvedPullRequestRun[]>();

  for (const proposal of proposals) {
    const entries = byTargetSha.get(proposal.targetSha) ?? [];

    entries.push(proposal);
    byTargetSha.set(proposal.targetSha, entries);
  }

  const prNumberBySha = new Map<string, number>();
  const resolvedRuns: ResolvedPullRequestRun[] = [];

  for (const [targetSha, runs] of byTargetSha) {
    if (runs.length !== 1) {
      providerComplete = false;
      continue;
    }

    prNumberBySha.set(targetSha, runs[0].prNumber);
    resolvedRuns.push(runs[0]);
  }

  if (!providerComplete) {
    log.warn(
      {
        projectId: input.project.id,
        provider,
        candidateCount: candidates.length,
      },
      "repo delivery scan has incomplete PR provider evidence",
    );
  }

  return { prNumberBySha, resolvedRuns, providerComplete };
}

function resolvedProvider(
  configuredProvider: string | null,
  origin: string,
): Provider {
  return isProvider(configuredProvider)
    ? configuredProvider
    : detectProvider(origin);
}

function isProvider(value: string | null): value is Provider {
  return (
    value === "github" ||
    value === "gitlab" ||
    value === "gitea" ||
    value === "gitverse" ||
    value === "generic"
  );
}

function bucketHistory(
  commits: readonly TimestampedDeliveryHistoryCommit[],
  now: Date,
  prNumberBySha: ReadonlyMap<string, number>,
): Bucket[] {
  const start = windowStart(now);
  const end = addUtcDays(startOfUtcDay(now), 1);
  const buckets: Bucket[] = Array.from(
    { length: REPO_DELIVERY_WINDOW_DAYS },
    (_, i): Bucket => {
      const bucketStart = addUtcDays(start, i);

      return {
        bucketStart,
        bucketEnd: addUtcDays(bucketStart, 1),
        commits: 0,
        mergePrUnits: 0,
        additions: 0,
        deletions: 0,
        deliveryRefs: [],
      };
    },
  );

  for (const commit of commits) {
    if (commit.committedAt < start || commit.committedAt > now) continue;

    const bucketIndex = Math.floor(
      (startOfUtcDay(commit.committedAt).getTime() - start.getTime()) / DAY_MS,
    );
    const bucket = buckets[bucketIndex];

    if (!bucket || commit.committedAt >= end) continue;

    const stat = cleanDeliveryStats(commit.files);
    const prNumber = prNumberBySha.get(commit.sha);

    bucket.commits += 1;
    bucket.mergePrUnits +=
      commit.parents.length > 1 || prNumber !== undefined ? 1 : 0;
    bucket.additions += stat.additions;
    bucket.deletions += stat.deletions;
    bucket.deliveryRefs.push(deliveryRef(commit, prNumber, stat));
  }

  return buckets;
}

function deliveryRef(
  commit: TimestampedDeliveryHistoryCommit,
  prNumber: number | undefined,
  diffStat: DeliveryDiffStat,
): RepoDeliveryRef {
  try {
    const trailers = parseMaisterTrailers(commit.message);

    return {
      sha: commit.sha,
      parentCount: commit.parents.length,
      runIds: trailers.runId ? [trailers.runId] : [],
      diffStat,
      ...(prNumber === undefined ? {} : { prNumber }),
    };
  } catch (error) {
    if (error instanceof MaisterProvenanceError) {
      throw new MaisterError(
        "CONFLICT",
        `repo_delivery_scan commit ${commit.sha} has invalid MAIster trailers: ${error.message}`,
        { cause: error },
      );
    }

    throw error;
  }
}

async function replaceProjectRollups(input: {
  db: RepoDeliveryScanDb;
  projectId: string;
  expectedBranch: string;
  buckets: readonly Bucket[];
  fetchedAt: Date;
  headSha: string;
  providerComplete: boolean;
  resolvedPullRequestRuns: readonly ResolvedPullRequestRun[];
}): Promise<void> {
  await input.db.transaction(async (tx) => {
    const locked = rowsOf<ProjectRow>(
      await tx.execute(sql`
        SELECT id, repo_path, provider, main_branch, archived_at
        FROM projects
        WHERE id = ${input.projectId}
        FOR UPDATE
      `),
    )[0];

    if (!locked || locked.archived_at !== null) {
      throw new MaisterError(
        "PRECONDITION",
        `repo_delivery_scan project is no longer active: ${input.projectId}`,
      );
    }
    if (locked.main_branch !== input.expectedBranch) {
      throw new MaisterError(
        "CONFLICT",
        `repo_delivery_scan target changed during scan: ${input.projectId}`,
      );
    }

    for (const run of input.resolvedPullRequestRuns) {
      const updated = rowsOf<{ id: string }>(
        await tx.execute(sql`
          UPDATE runs AS run
          SET
            promoted_head_sha = ${run.targetSha},
            merge_commit_sha = ${run.targetSha},
            diff_stat = ${JSON.stringify(run.diffStat)}::jsonb
          FROM workspaces AS workspace
          WHERE run.id = workspace.run_id
            AND run.id = ${run.runId}
            AND workspace.project_id = ${input.projectId}
            AND workspace.pr_number = ${run.prNumber}
            AND workspace.target_branch = ${input.expectedBranch}
            AND workspace.promotion_state = 'done'
            AND workspace.promoted_at IS NOT NULL
          RETURNING run.id
        `),
      );

      if (updated.length !== 1) {
        throw new MaisterError(
          "CONFLICT",
          `repo_delivery_scan PR evidence changed during scan: ${run.runId}`,
        );
      }
    }

    await tx.execute(sql`
      DELETE FROM repo_delivery_rollups
      WHERE project_id = ${input.projectId}
    `);

    for (const bucket of input.buckets) {
      await tx.execute(sql`
        INSERT INTO repo_delivery_rollups (
          id,
          project_id,
          branch,
          bucket_start,
          bucket_end,
          commits,
          merge_pr_units,
          additions,
          deletions,
          delivery_refs,
          provider_complete,
          fetched_at,
          head_sha,
          created_at,
          updated_at
        )
        VALUES (
          ${randomUUID()},
          ${input.projectId},
          ${input.expectedBranch},
          ${bucket.bucketStart},
          ${bucket.bucketEnd},
          ${bucket.commits},
          ${bucket.mergePrUnits},
          ${bucket.additions},
          ${bucket.deletions},
          ${JSON.stringify(bucket.deliveryRefs)}::jsonb,
          ${input.providerComplete},
          ${input.fetchedAt},
          ${input.headSha},
          ${input.fetchedAt},
          ${input.fetchedAt}
        )
      `);
    }
  });
}

function summarize(input: {
  projectId: string;
  branch: string;
  headSha: string;
  buckets: readonly Bucket[];
  fetchedAt: Date;
}): RepoDeliveryScanSummary {
  return {
    projectId: input.projectId,
    branch: input.branch,
    headSha: input.headSha,
    bucketCount: input.buckets.length,
    commits: sum(input.buckets.map((bucket) => bucket.commits)),
    additions: sum(input.buckets.map((bucket) => bucket.additions)),
    deletions: sum(input.buckets.map((bucket) => bucket.deletions)),
    fetchedAt: input.fetchedAt,
  };
}

function windowStart(now: Date): Date {
  return addUtcDays(startOfUtcDay(now), -(REPO_DELIVERY_WINDOW_DAYS - 1));
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function rowsOf<T>(result: QueryResult): T[] {
  return (result.rows ?? []) as T[];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
