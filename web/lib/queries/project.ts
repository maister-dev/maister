import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { Project, RunKind, ScratchDialogStatus } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";
import {
  ACTIVE_RUN_STATUSES,
  type AgentRole,
  type PortfolioWorkspace,
  lifecycleActionsForWorkspace,
  relativeTime,
  runStatusToWorkspace,
  scratchActionForWorkspace,
} from "@/lib/queries/portfolio";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";

const {
  flowRunnerRemaps,
  flows,
  platformAcpRunners,
  platformRuntimeSettings,
  projectMembers,
  projects,
  runs,
  scratchRuns,
  users,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type ProjectAgent = AdapterId;

export interface ProjectFlow {
  id: string;
  ref: string;
  source: string;
  version: string;
  stepCount: number;
}

export interface ProjectRunner {
  id: string;
  agent: ProjectAgent;
  label: string;
  readinessStatus: "Unknown" | "Ready" | "NotReady";
  enabled: boolean;
}

export interface ProjectFlowRunnerRemap {
  id: string;
  flowId: string | null;
  flowRef: string;
  flowRevisionId: string;
  stepId: string;
  sourceRunnerId: string;
  mappedRunnerId: string | null;
  status: "Pending" | "Mapped";
}

export interface ProjectMemberView {
  initials: string;
  name: string;
  isAdmin: boolean;
}

export interface ProjectPageData {
  project: Project;
  flows: ProjectFlow[];
  runners: ProjectRunner[];
  flowRunnerRemaps: ProjectFlowRunnerRemap[];
  members: ProjectMemberView[];
  activeWorkspaces: PortfolioWorkspace[];
  defaultRunnerId: string | null;
  effectiveDefaultRunnerId: string | null;
  defaultRunnerSource: "project" | "platform" | null;
  defaultAgent: ProjectAgent | null;
  defaultRunnerLabel: string | null;
}

function initialsOf(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "?").trim();
  const parts = source.split(/[\s@.]+/).filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function stepCountOf(manifest: unknown): number {
  if (manifest === null || typeof manifest !== "object") return 0;
  const steps = (manifest as { steps?: unknown }).steps;

  return Array.isArray(steps) ? steps.length : 0;
}

export interface ProjectOption {
  id: string;
  name: string;
  slug: string;
}

/** All non-archived projects, for the admin user-list project filter. */
export async function listProjectOptions(): Promise<ProjectOption[]> {
  return db()
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(asc(projects.name));
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const rows = await db()
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));

  return rows[0] ?? null;
}

export async function getProjectPageData(
  project: Project,
): Promise<ProjectPageData> {
  const client = db();

  const now = new Date();
  const [flowRows, runnerRows, platformRuntimeRows, memberRows, activeRunRows] =
    await Promise.all([
      client
        .select({
          id: flows.id,
          ref: flows.flowRefId,
          source: flows.source,
          version: flows.version,
          manifest: flows.manifest,
          enabledRevisionId: flows.enabledRevisionId,
        })
        .from(flows)
        .where(eq(flows.projectId, project.id))
        .orderBy(asc(flows.createdAt)),
      client
        .select({
          id: platformAcpRunners.id,
          agent: platformAcpRunners.capabilityAgent,
          adapter: platformAcpRunners.adapter,
          model: platformAcpRunners.model,
          readinessStatus: platformAcpRunners.readinessStatus,
          enabled: platformAcpRunners.enabled,
        })
        .from(platformAcpRunners)
        .orderBy(asc(platformAcpRunners.createdAt)),

      client.select().from(platformRuntimeSettings),

      client
        .select({
          name: users.name,
          email: users.email,
          role: projectMembers.role,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(eq(projectMembers.projectId, project.id)),

      // M34: leftJoin — none/repo_read agent runs have no workspaces row but
      // still belong in the active strip.
      client
        .select({
          runId: runs.id,
          status: runs.status,
          runKind: runs.runKind,
          agentId: runs.agentId,
          triggerSource: runs.triggerSource,
          acpSessionId: runs.acpSessionId,
          capabilityAgent: runs.capabilityAgent,
          runnerSnapshot: runs.runnerSnapshot,
          workspaceId: workspaces.id,
          branch: workspaces.branch,
          archivedBranch: workspaces.archivedBranch,
          removedAt: workspaces.removedAt,
          startedAt: runs.startedAt,
          scratchDialogStatus: scratchRuns.dialogStatus,
        })
        .from(runs)
        .leftJoin(workspaces, eq(workspaces.runId, runs.id))
        .leftJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
        .where(
          and(
            eq(runs.projectId, project.id),
            inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
            // Live workspace rows as before — plus workspace-LESS rows only
            // for agent runs (none/repo_read have no worktree by design).
            // A bare IS NULL would also surface seeded/legacy kindless rows.
            or(
              and(isNotNull(workspaces.id), isNull(workspaces.removedAt)),
              and(eq(runs.runKind, "agent"), isNull(workspaces.id)),
            ),
          ),
        )
        .orderBy(desc(runs.startedAt)),
    ]);

  const flowByRevisionId = new Map(
    flowRows
      .filter((flow) => flow.enabledRevisionId)
      .map((flow) => [
        flow.enabledRevisionId as string,
        { id: flow.id, ref: flow.ref },
      ]),
  );

  const projectFlows: ProjectFlow[] = flowRows.map((f) => ({
    id: f.id,
    ref: f.ref,
    source: f.source,
    version: f.version,
    stepCount: stepCountOf(f.manifest),
  }));

  const projectRunners: ProjectRunner[] = runnerRows.map((runner) => ({
    id: runner.id,
    agent: runner.agent,
    label: `${runner.id} · ${runner.adapter} · ${runner.model}`,
    readinessStatus: runner.readinessStatus,
    enabled: runner.enabled,
  }));
  const remapRows = await client
    .select({
      id: flowRunnerRemaps.id,
      flowRevisionId: flowRunnerRemaps.flowRevisionId,
      stepId: flowRunnerRemaps.stepId,
      sourceRunnerId: flowRunnerRemaps.sourceRunnerId,
      mappedRunnerId: flowRunnerRemaps.mappedRunnerId,
      status: flowRunnerRemaps.status,
    })
    .from(flowRunnerRemaps)
    .where(eq(flowRunnerRemaps.projectId, project.id))
    .orderBy(asc(flowRunnerRemaps.stepId));
  const projectFlowRunnerRemaps: ProjectFlowRunnerRemap[] = remapRows.map(
    (remap) => {
      const flow = flowByRevisionId.get(remap.flowRevisionId);

      return {
        id: remap.id,
        flowId: flow?.id ?? null,
        flowRef: flow?.ref ?? remap.flowRevisionId,
        flowRevisionId: remap.flowRevisionId,
        stepId: remap.stepId,
        sourceRunnerId: remap.sourceRunnerId,
        mappedRunnerId: remap.mappedRunnerId,
        status: remap.status as "Pending" | "Mapped",
      };
    },
  );

  const members: ProjectMemberView[] = memberRows.map((m) => ({
    initials: initialsOf(m.name, m.email),
    name: m.name ?? m.email ?? "?",
    isAdmin: m.role === "owner" || m.role === "admin",
  }));
  // T16 (M15, ADR-048): unified readiness per active run via the shared
  // readiness-core SSOT (same classifier the portfolio + board use) — no per-run
  // getRunReadiness, no N+1.
  const readinessByRun = await computeReadinessByRun(
    client,
    activeRunRows.map((row) => row.runId),
  );
  const activeWorkspaces: PortfolioWorkspace[] = activeRunRows.map((row) => ({
    runId: row.runId,
    runKind: row.runKind as RunKind,
    branch: row.branch ?? row.agentId ?? "—",
    agentId: row.agentId ?? null,
    triggerSource: row.triggerSource ?? null,
    agent: runnerAgentFromFields({
      capabilityAgent: row.capabilityAgent,
      runnerSnapshot: row.runnerSnapshot,
      context: row.runId,
    }) as AgentRole,
    status: runStatusToWorkspace(row.status),
    time: relativeTime(row.startedAt, now),
    href:
      row.runKind === "scratch"
        ? `/scratch-runs/${row.runId}`
        : `/runs/${row.runId}`,
    scratchDialogStatus: row.scratchDialogStatus as ScratchDialogStatus | null,
    scratchAction: scratchActionForWorkspace({
      runKind: row.runKind as RunKind,
      runStatus: row.status,
      dialogStatus: row.scratchDialogStatus as ScratchDialogStatus | null,
      acpSessionId: row.acpSessionId,
    }),
    lifecycleActions: lifecycleActionsForWorkspace({
      runKind: row.runKind as RunKind,
      runStatus: row.status,
      dialogStatus: row.scratchDialogStatus as ScratchDialogStatus | null,
      hasWorkspace: Boolean(row.workspaceId),
      removedAt: row.removedAt,
      archivedBranch: row.archivedBranch,
    }),
    // ACTIVE_RUN_STATUSES excludes Done/Abandoned; a gate-less run → "ready".
    readiness: readinessByRun.get(row.runId) ?? "ready",
  }));

  const platformDefaultRunnerId =
    platformRuntimeRows[0]?.defaultRunnerId ?? null;
  const effectiveDefaultRunnerId =
    project.defaultRunnerId ?? platformDefaultRunnerId;
  const defaultRunner = effectiveDefaultRunnerId
    ? projectRunners.find((runner) => runner.id === effectiveDefaultRunnerId)
    : undefined;
  const defaultRunnerSource = project.defaultRunnerId
    ? "project"
    : platformDefaultRunnerId
      ? "platform"
      : null;

  return {
    project,
    flows: projectFlows,
    runners: projectRunners,
    flowRunnerRemaps: projectFlowRunnerRemaps,
    members,
    activeWorkspaces,
    defaultRunnerId: project.defaultRunnerId,
    effectiveDefaultRunnerId,
    defaultRunnerSource,
    defaultAgent: defaultRunner?.agent ?? null,
    defaultRunnerLabel: defaultRunner?.label ?? null,
  };
}
