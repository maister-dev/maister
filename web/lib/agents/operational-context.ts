import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type {
  OperationalRefEvidence,
  OperationalIntegrityResult,
} from "@/lib/agents/operational-integrity";
import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type {
  OperationalIntegrityBaseline,
  OperationalResourceKind,
} from "@/lib/run-results/operational-types";

import { and, eq, ne } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
  verifyOperationalIntegrity,
} from "@/lib/agents/operational-integrity";
import {
  agentWorkdirPath,
  agentReadOnlyWorkdirPath,
} from "@/lib/agents/workspace-paths";
import { projects, runs, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "operational-integrity" });

export function operationalResourceKind(
  run: Pick<Run, "agentWorkspace" | "resultContract">,
): OperationalResourceKind {
  if (run.agentWorkspace === "worktree") return "worktree";
  if (run.agentWorkspace === "none") return "plain_directory";
  if (run.agentWorkspace === "repo_read")
    return run.resultContract?.kind === "agent_operational" &&
      run.resultContract.definition.workspaceRef
      ? "ephemeral_checkout"
      : "shared_repository";
  throw new MaisterError(
    "CONFIG",
    "operational run is missing its workspace snapshot",
  );
}

export async function operationalReferenceEvidence(
  db: Db,
  run: Pick<Run, "id" | "projectId">,
): Promise<OperationalRefEvidence[]> {
  const rows = await db
    .select({
      branch: workspaces.branch,
      baseCommit: workspaces.baseCommit,
      removedAt: workspaces.removedAt,
      archivedBranch: workspaces.archivedBranch,
      archivedCommit: workspaces.archivedCommit,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        eq(workspaces.projectId, run.projectId ?? ""),
        eq(runs.agentKind, "operational"),
        ne(runs.id, run.id),
      ),
    );

  return rows.flatMap((row): OperationalRefEvidence[] => [
    ...(row.baseCommit
      ? [
          {
            kind: "allocated" as const,
            ref: `refs/heads/${row.branch}`,
            sha: row.baseCommit,
          },
          ...(row.removedAt
            ? [
                {
                  kind: "disposed" as const,
                  ref: `refs/heads/${row.branch}`,
                  sha: row.baseCommit,
                },
              ]
            : []),
        ]
      : []),
    ...(row.archivedAt && row.archivedBranch && row.archivedCommit
      ? [
          {
            kind: "allocated" as const,
            ref: `refs/heads/${row.archivedBranch}`,
            sha: row.archivedCommit,
          },
        ]
      : []),
  ]);
}

export async function operationalWorkspace(
  db: Db,
  run: Pick<Run, "id" | "projectId" | "agentWorkspace" | "resultContract"> &
    Partial<Pick<Run, "operationalIntegrityBaseline">>,
): Promise<{
  cwd: string;
  resourceKind: OperationalResourceKind;
  projectSlug: string;
  repoPath: string;
}> {
  const owner = run.operationalIntegrityBaseline?.owner;

  if (owner) return { ...owner, resourceKind: operationalResourceKind(run) };
  const [project] = await db
    .select({ slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, run.projectId ?? ""));

  if (!project)
    throw new MaisterError(
      "PRECONDITION",
      "operational workspace requires its project",
    );
  const resourceKind = operationalResourceKind(run);
  const [workspace] =
    resourceKind === "worktree"
      ? await db
          .select({
            path: workspaces.worktreePath,
            parentRepoPath: workspaces.parentRepoPath,
          })
          .from(workspaces)
          .where(eq(workspaces.runId, run.id))
      : [];
  const cwd =
    resourceKind === "shared_repository"
      ? project.repoPath
      : resourceKind === "ephemeral_checkout"
        ? agentReadOnlyWorkdirPath(project.slug, run.id)
        : (workspace?.path ?? agentWorkdirPath(project.slug, run.id));

  return {
    cwd,
    resourceKind,
    projectSlug: project.slug,
    repoPath: workspace?.parentRepoPath ?? project.repoPath,
  };
}

export async function inspectOperationalWorkspace(
  db: Db,
  run: Pick<
    Run,
    | "id"
    | "projectId"
    | "agentKind"
    | "agentWorkspace"
    | "resultContract"
    | "operationalIntegrityBaseline"
  >,
): Promise<OperationalIntegrityResult> {
  frozenOperationalDefinition(run);
  const context = await operationalWorkspace(db, run);
  const result = await verifyOperationalIntegrity(
    context.cwd,
    run.operationalIntegrityBaseline,
    await operationalReferenceEvidence(db, run),
  );

  log.info(
    {
      runId: run.id,
      verdict: result.verdict,
      reasons: result.reasonCodes,
      changedPathCount: result.changedPaths.length,
      generation: run.operationalIntegrityBaseline?.generation ?? null,
    },
    "operational-source-integrity",
  );

  return result;
}

/** Captured before the first source baseline is committed; never re-materialized on resume. */
export async function captureOperationalContextMounts(
  mounts: readonly ContextMountSnapshot[],
): Promise<NonNullable<OperationalIntegrityBaseline["contextMounts"]>> {
  const witnesses: NonNullable<OperationalIntegrityBaseline["contextMounts"]> =
    [];

  for (const mount of mounts) {
    const baseline = await captureOperationalGeneration(
      mount.mountPath,
      await captureOperationalBaseline(mount.mountPath, "ephemeral_checkout"),
      [],
    );

    if (baseline.head !== mount.committish)
      throw new MaisterError(
        "PRECONDITION",
        "Context checkout does not match its resolved launch commit",
        {
          details: {
            reason: "operational_context_commit_mismatch",
            siblingProjectId: mount.projectId,
          },
        },
      );
    witnesses.push({ mount, baseline });
  }

  return witnesses;
}

type OperationalContextRun = Pick<
  Run,
  "id" | "operationalIntegrityBaseline" | "contextMounts"
>;

/** Immutable witnesses own cleanup paths; the legacy column remains launch provenance. */
export function operationalContextMountSnapshots(
  run: OperationalContextRun,
): ContextMountSnapshot[] {
  return (
    run.operationalIntegrityBaseline?.contextMounts?.map(
      ({ mount }) => mount,
    ) ??
    run.contextMounts ??
    []
  );
}

export function assertOperationalContextSnapshot(
  run: OperationalContextRun,
): void {
  if (
    canonicalCommandJson(operationalContextMountSnapshots(run)) !==
    canonicalCommandJson(run.contextMounts ?? [])
  )
    throw new MaisterError(
      "PRECONDITION",
      "Operational context ownership differs from the frozen launch witness; diagnose before cleanup",
      { details: { reason: "operational_context_snapshot_changed" } },
    );
}

export async function inspectOperationalContextMount(
  db: Db,
  run: OperationalContextRun,
  mount: ContextMountSnapshot,
): Promise<OperationalIntegrityResult> {
  const witness = run.operationalIntegrityBaseline?.contextMounts?.find(
    (entry) =>
      canonicalCommandJson(entry.mount) === canonicalCommandJson(mount),
  );

  if (!witness)
    return {
      verdict: "indeterminate",
      reasonCodes: ["operational_context_baseline_missing"],
      changedPaths: [],
    };

  return verifyOperationalIntegrity(
    mount.mountPath,
    witness.baseline,
    await operationalReferenceEvidence(db, {
      id: run.id,
      projectId: mount.projectId,
    }),
  );
}

export async function inspectOperationalContexts(
  db: Db,
  run: OperationalContextRun,
): Promise<OperationalIntegrityResult> {
  const results: OperationalIntegrityResult[] = [];
  const mounts = operationalContextMountSnapshots(run);

  if (
    canonicalCommandJson(mounts) !==
    canonicalCommandJson(run.contextMounts ?? [])
  )
    results.push({
      verdict: "indeterminate",
      reasonCodes: ["operational_context_snapshot_changed"],
      changedPaths: [],
    });

  for (const mount of mounts) {
    const result = await inspectOperationalContextMount(db, run, mount);

    results.push({
      ...result,
      changedPaths: result.changedPaths.map(
        (entry) => `context/${mount.slug}/${entry}`,
      ),
      reasonCodes:
        result.verdict === "clean"
          ? []
          : ["operational_context_integrity_refused", ...result.reasonCodes],
    });
    log.info(
      {
        runId: run.id,
        siblingProjectId: mount.projectId,
        verdict: result.verdict,
        reasons: result.reasonCodes,
      },
      "[FIX:operational-context] sibling source integrity validated",
    );
  }

  return combineIntegrityResults(results);
}

function combineIntegrityResults(
  results: readonly OperationalIntegrityResult[],
): OperationalIntegrityResult {
  return {
    verdict: results.some(({ verdict }) => verdict === "changed")
      ? "changed"
      : results.some(({ verdict }) => verdict !== "clean")
        ? "indeterminate"
        : "clean",
    reasonCodes: [
      ...new Set(results.flatMap(({ reasonCodes }) => reasonCodes)),
    ],
    changedPaths: results.flatMap(({ changedPaths }) => changedPaths),
  };
}

export async function inspectOperationalRun(
  db: Db,
  run: Parameters<typeof inspectOperationalWorkspace>[1] &
    Pick<Run, "contextMounts">,
): Promise<OperationalIntegrityResult> {
  return combineIntegrityResults([
    await inspectOperationalWorkspace(db, run),
    await inspectOperationalContexts(db, run),
  ]);
}

export async function assertOperationalDispatchIntegrity(
  db: Db,
  runId: string,
): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (run?.agentKind !== "operational") return;
  const result = await inspectOperationalRun(db, run);

  if (result.verdict !== "clean")
    throw new MaisterError(
      "PRECONDITION",
      "operational source integrity changed before dispatch; diagnose this attempt before retrying",
      {
        details: {
          reason: "operational_integrity_refused",
          reasons: result.reasonCodes,
        },
      },
    );
}
