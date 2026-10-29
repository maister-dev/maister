import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type {
  OperationalRefEvidence,
  OperationalIntegrityResult,
} from "@/lib/agents/operational-integrity";
import type { OperationalResourceKind } from "@/lib/run-results/operational-types";

import { and, eq, ne } from "drizzle-orm";
import pino from "pino";

import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import { verifyOperationalIntegrity } from "@/lib/agents/operational-integrity";
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

  return rows.flatMap((row): OperationalRefEvidence[] =>
    row.baseCommit
      ? [
          {
            kind: "allocated",
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
      : [],
  );
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

export async function inspectOperationalRun(
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
