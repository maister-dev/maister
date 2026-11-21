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

import { companyExecutionSnapshotSchema } from "@/lib/agents/company-execution-types";
import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
  verifyOperationalIntegrity,
} from "@/lib/agents/operational-integrity";
import {
  agentWorkdirPath,
  agentReadOnlyWorkdirPath,
  companyAgentWorkdirPath,
  companyAgentRuntimePath,
  operationalAgentRuntimePath,
} from "@/lib/agents/workspace-paths";
import { projects, runs, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "operational-integrity",
  level: process.env.LOG_LEVEL ?? "info",
});

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
  db: Pick<Db, "select">,
  run: Pick<Run, "id" | "projectId">,
): Promise<OperationalRefEvidence[]> {
  if (run.projectId === null) return [];
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
        eq(workspaces.projectId, run.projectId),
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

type OperationalWorkspaceRun = Pick<
  Run,
  "id" | "projectId" | "agentWorkspace" | "resultContract"
> &
  Partial<
    Pick<
      Run,
      | "operationalIntegrityBaseline"
      | "companyId"
      | "companyExecutionSnapshot"
      | "runKind"
    >
  >;

export type OperationalWorkspaceContext =
  | {
      ownerKind: "project";
      cwd: string;
      runtimePath: string;
      resourceKind: OperationalResourceKind;
      projectSlug: string;
      repoPath: string;
    }
  | {
      ownerKind: "company";
      companyId: string;
      cwd: string;
      runtimePath: string;
      resourceKind: "plain_directory";
      projectSlug: null;
      repoPath: null;
    };

/** Retained company graph ownership admits the same resource lifecycle without impersonating an operational-agent result. */
export function isCompanyFlowResource(
  run: OperationalWorkspaceRun,
): run is OperationalWorkspaceRun & {
  companyId: string;
  runKind: "flow";
  resultContract: Extract<
    NonNullable<Run["resultContract"]>,
    { kind: "flow_export" }
  > & { required: true };
} {
  const capture = companyExecutionSnapshotSchema.safeParse(
    run.companyExecutionSnapshot,
  );

  return (
    run.runKind === "flow" &&
    run.projectId === null &&
    run.companyId != null &&
    run.agentWorkspace === "none" &&
    run.resultContract?.kind === "flow_export" &&
    run.resultContract.required &&
    capture.success &&
    capture.data.schemaVersion === 2 &&
    capture.data.owner.companyId === run.companyId
  );
}

function companyOperationalWorkspace(
  run: OperationalWorkspaceRun,
): OperationalWorkspaceContext {
  const capture = companyExecutionSnapshotSchema.safeParse(
    run.companyExecutionSnapshot,
  );

  if (
    !capture.success ||
    capture.data.owner.companyId !== run.companyId ||
    run.projectId !== null
  )
    throw new MaisterError(
      "PRECONDITION",
      "Company workspace requires its exact retained execution owner",
      {
        details: { reason: "company_workspace_owner_missing" },
      },
    );
  if (
    run.agentWorkspace !== "none" ||
    (capture.data.schemaVersion === 2
      ? run.runKind !== "flow" ||
        run.resultContract?.kind !== "flow_export" ||
        !run.resultContract.required
      : (run.runKind !== undefined && run.runKind !== "agent") ||
        run.resultContract?.kind !== "agent_operational")
  )
    throw new MaisterError(
      "CONFIG",
      "Company operational work requires a plain run directory",
      {
        details: { reason: "company_workspace_unsupported" },
      },
    );
  const companyId = capture.data.owner.companyId;
  const cwd = companyAgentWorkdirPath(companyId, run.id);
  const runtimePath = companyAgentRuntimePath(companyId, run.id);
  const baseline = run.operationalIntegrityBaseline;
  const owner = baseline?.owner;

  if (
    baseline &&
    (baseline.resourceKind !== "plain_directory" ||
      !owner ||
      !("kind" in owner) ||
      owner.kind !== "company" ||
      owner.companyId !== companyId ||
      owner.runId !== run.id ||
      owner.cwd !== cwd ||
      owner.runtimePath !== runtimePath)
  )
    throw new MaisterError(
      "PRECONDITION",
      "Company workspace baseline does not match its retained owner and managed paths",
      {
        details: { reason: "company_workspace_owner_mismatch" },
      },
    );

  log.debug(
    {
      runId: run.id,
      companyId,
      resourceKind: "plain_directory",
      baselineGeneration: baseline?.generation ?? null,
    },
    "company operational workspace owner resolved",
  );

  return {
    ownerKind: "company",
    companyId,
    cwd,
    runtimePath,
    resourceKind: "plain_directory",
    projectSlug: null,
    repoPath: null,
  };
}

export async function operationalWorkspace(
  db: Pick<Db, "select">,
  run: OperationalWorkspaceRun,
): Promise<OperationalWorkspaceContext> {
  if (run.companyId != null) return companyOperationalWorkspace(run);
  const owner = run.operationalIntegrityBaseline?.owner;

  if (owner && "kind" in owner)
    throw new MaisterError(
      "PRECONDITION",
      "Project workspace cannot use a company baseline owner",
    );
  if (owner)
    return {
      ...owner,
      ownerKind: "project",
      runtimePath: operationalAgentRuntimePath(owner.projectSlug, run.id),
      resourceKind: operationalResourceKind(run),
    };
  if (run.projectId === null)
    throw new MaisterError(
      "PRECONDITION",
      "Operational workspace requires an explicit project or company execution owner",
    );
  const [project] = await db
    .select({ slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, run.projectId));

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
    ownerKind: "project",
    cwd,
    runtimePath: operationalAgentRuntimePath(project.slug, run.id),
    resourceKind,
    projectSlug: project.slug,
    repoPath: workspace?.parentRepoPath ?? project.repoPath,
  };
}

export async function inspectOperationalWorkspace(
  db: Pick<Db, "select">,
  run: Pick<
    Run,
    | "id"
    | "projectId"
    | "agentKind"
    | "agentWorkspace"
    | "resultContract"
    | "operationalIntegrityBaseline"
  > &
    Partial<Pick<Run, "companyId" | "companyExecutionSnapshot" | "runKind">>,
  stage: "dispatch" | "final_verification" | "cleanup" = "final_verification",
): Promise<OperationalIntegrityResult> {
  frozenOperationalDefinition(run);
  const context = await operationalWorkspace(db, run);
  const result = await verifyOperationalIntegrity(
    db,
    context.cwd,
    run.operationalIntegrityBaseline,
    await operationalReferenceEvidence(db, run),
    { stage },
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
  db: Db,
  mounts: readonly ContextMountSnapshot[],
): Promise<NonNullable<OperationalIntegrityBaseline["contextMounts"]>> {
  const witnesses: NonNullable<OperationalIntegrityBaseline["contextMounts"]> =
    [];

  for (const mount of mounts) {
    const baseline = await captureOperationalGeneration(
      db,
      mount.mountPath,
      await captureOperationalBaseline(
        db,
        mount.mountPath,
        "ephemeral_checkout",
        { resource: "context" },
      ),
      [],
      { resource: "context" },
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
  stage: "dispatch" | "final_verification" | "cleanup" = "final_verification",
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
    db,
    mount.mountPath,
    witness.baseline,
    await operationalReferenceEvidence(db, {
      id: run.id,
      projectId: mount.projectId,
    }),
    { resource: "context", stage },
  );
}

export async function inspectOperationalContexts(
  db: Db,
  run: OperationalContextRun,
  stage: "dispatch" | "final_verification" = "final_verification",
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
    const result = await inspectOperationalContextMount(db, run, mount, stage);

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
  const integrityLimit = results.find(
    (result) => result.integrityLimit,
  )?.integrityLimit;

  return {
    ...(integrityLimit ? { integrityLimit } : {}),
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
  stage: "dispatch" | "final_verification" = "final_verification",
): Promise<OperationalIntegrityResult> {
  return combineIntegrityResults([
    await inspectOperationalWorkspace(db, run, stage),
    await inspectOperationalContexts(db, run, stage),
  ]);
}

export async function assertOperationalDispatchIntegrity(
  db: Db,
  runId: string,
): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (!run || (run.agentKind !== "operational" && !isCompanyFlowResource(run)))
    return;
  const result = await inspectOperationalRun(db, run, "dispatch");

  if (result.verdict !== "clean")
    throw new MaisterError(
      "PRECONDITION",
      "operational source integrity changed before dispatch; diagnose this attempt before retrying",
      {
        details: {
          reason: "operational_integrity_refused",
          reasons: result.reasonCodes,
          integrityLimit: result.integrityLimit,
        },
      },
    );
}
