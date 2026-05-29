import "server-only";

import type { GlobalRole, ProjectRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const {
  executors,
  flows,
  hitlRequests,
  projectMembers,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

const ACTIVE_RUN_STATUSES = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "Review",
  "Crashed",
] as const;

export type PortfolioStatus = "running" | "idle";
export type AgentRole = "claude" | "codex" | "dev";
export type WorkspaceStatus = "running" | "needs" | "queued" | "done";

export interface PortfolioMember {
  initials: string;
  name: string;
  role: ProjectRole;
  isAdmin: boolean;
}

export interface PortfolioWorkspace {
  branch: string;
  agent: AgentRole;
  status: WorkspaceStatus;
  time: string;
}

export interface PortfolioRecentMerge {
  branch: string;
  agent: AgentRole;
  time: string;
}

export interface PortfolioNeed {
  runId: string;
  prompt: string;
  agent: AgentRole;
  branch: string;
}

export interface PortfolioProject {
  id: string;
  slug: string;
  name: string;
  accent: 1 | 2 | 3 | 4;
  status: PortfolioStatus;
  defaultAgent: AgentRole | null;
  flowsCount: number;
  backlogCount: number;
  pendingHitlCount: number;
  humansCount: number;
  agentsCount: number;
  members: PortfolioMember[];
  agents: AgentRole[];
  activeWorkspaces: PortfolioWorkspace[];
  recentMerges: PortfolioRecentMerge[];
  need: PortfolioNeed | null;
}

export interface Portfolio {
  projects: PortfolioProject[];
  totalActiveWorkspaces: number;
  totalNeeds: number;
}

function relativeTime(from: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 1000),
  );

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);

  return `${days}d`;
}

function initialsOf(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "?").trim();
  const parts = source.split(/[\s@.]+/).filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function runStatusToWorkspace(status: string): WorkspaceStatus {
  if (status === "Running") return "running";
  if (status === "NeedsInput" || status === "NeedsInputIdle") return "needs";
  if (status === "Pending") return "queued";

  return "done";
}

const ACCENTS: readonly (1 | 2 | 3 | 4)[] = [1, 3, 2, 4];

export async function getPortfolio(
  userId: string,
  globalRole: GlobalRole,
): Promise<Portfolio> {
  const now = new Date();
  const client = db();

  const visibleProjects =
    globalRole === "admin"
      ? await client
          .select()
          .from(projects)
          .where(isNull(projects.archivedAt))
          .orderBy(projects.createdAt)
      : await client
          .select({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            repoPath: projects.repoPath,
            mainBranch: projects.mainBranch,
            branchPrefix: projects.branchPrefix,
            maisterYamlPath: projects.maisterYamlPath,
            defaultExecutorId: projects.defaultExecutorId,
            createdAt: projects.createdAt,
            archivedAt: projects.archivedAt,
          })
          .from(projects)
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(
            and(eq(projectMembers.userId, userId), isNull(projects.archivedAt)),
          )
          .orderBy(projects.createdAt);

  if (visibleProjects.length === 0) {
    return { projects: [], totalActiveWorkspaces: 0, totalNeeds: 0 };
  }

  const projectIds = visibleProjects.map((p) => p.id);

  const [
    memberRows,
    flowCountRows,
    backlogRows,
    activeRunRows,
    recentMergeRows,
    needRows,
  ] = await Promise.all([
    client
      .select({
        projectId: projectMembers.projectId,
        role: projectMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(inArray(projectMembers.projectId, projectIds)),

    client
      .select({ projectId: flows.projectId, value: count() })
      .from(flows)
      .where(inArray(flows.projectId, projectIds))
      .groupBy(flows.projectId),

    client
      .select({ projectId: tasks.projectId, value: count() })
      .from(tasks)
      .where(
        and(inArray(tasks.projectId, projectIds), eq(tasks.status, "Backlog")),
      )
      .groupBy(tasks.projectId),

    client
      .select({
        projectId: runs.projectId,
        status: runs.status,
        agent: executors.agent,
        branch: workspaces.branch,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .innerJoin(executors, eq(executors.id, runs.executorId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(
        and(
          inArray(runs.projectId, projectIds),
          inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
          isNull(workspaces.removedAt),
        ),
      )
      .orderBy(desc(runs.startedAt)),

    client
      .select({
        projectId: runs.projectId,
        agent: executors.agent,
        branch: workspaces.branch,
        endedAt: runs.endedAt,
      })
      .from(runs)
      .innerJoin(executors, eq(executors.id, runs.executorId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(
        and(
          inArray(runs.projectId, projectIds),
          eq(runs.status, "Done"),
          isNull(workspaces.removedAt),
        ),
      )
      .orderBy(desc(runs.endedAt)),

    client
      .select({
        projectId: runs.projectId,
        runId: runs.id,
        prompt: hitlRequests.prompt,
        agent: executors.agent,
        branch: workspaces.branch,
        createdAt: hitlRequests.createdAt,
      })
      .from(hitlRequests)
      .innerJoin(runs, eq(runs.id, hitlRequests.runId))
      .innerJoin(executors, eq(executors.id, runs.executorId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(
        and(
          inArray(runs.projectId, projectIds),
          isNull(hitlRequests.respondedAt),
          isNull(workspaces.removedAt),
        ),
      )
      .orderBy(desc(hitlRequests.createdAt)),
  ]);

  const defaultAgentRows = await client
    .select({
      projectId: executors.projectId,
      agent: executors.agent,
      id: executors.id,
    })
    .from(executors)
    .where(inArray(executors.projectId, projectIds));

  const defaultExecutorByProject = new Map<string, string | null>();

  for (const p of visibleProjects) {
    defaultExecutorByProject.set(p.id, p.defaultExecutorId ?? null);
  }
  const agentByExecutorId = new Map<string, AgentRole>();

  for (const row of defaultAgentRows) {
    agentByExecutorId.set(row.id, row.agent as AgentRole);
  }

  const membersByProject = new Map<string, PortfolioMember[]>();

  for (const row of memberRows) {
    const list = membersByProject.get(row.projectId) ?? [];
    const role = row.role as ProjectRole;

    list.push({
      initials: initialsOf(row.name, row.email),
      name: row.name ?? row.email ?? "?",
      role,
      isAdmin: role === "owner" || role === "admin",
    });
    membersByProject.set(row.projectId, list);
  }

  const flowsCountByProject = new Map<string, number>();

  for (const row of flowCountRows) {
    flowsCountByProject.set(row.projectId, Number(row.value));
  }

  const backlogByProject = new Map<string, number>();

  for (const row of backlogRows) {
    backlogByProject.set(row.projectId, Number(row.value));
  }

  const workspacesByProject = new Map<string, PortfolioWorkspace[]>();

  for (const row of activeRunRows) {
    const list = workspacesByProject.get(row.projectId) ?? [];

    list.push({
      branch: row.branch,
      agent: row.agent as AgentRole,
      status: runStatusToWorkspace(row.status),
      time: relativeTime(row.startedAt, now),
    });
    workspacesByProject.set(row.projectId, list);
  }

  const mergesByProject = new Map<string, PortfolioRecentMerge[]>();

  for (const row of recentMergeRows) {
    const list = mergesByProject.get(row.projectId) ?? [];

    if (list.length >= 2) continue;
    list.push({
      branch: row.branch,
      agent: row.agent as AgentRole,
      time: row.endedAt ? relativeTime(row.endedAt, now) : "—",
    });
    mergesByProject.set(row.projectId, list);
  }

  const needCountByProject = new Map<string, number>();
  const firstNeedByProject = new Map<string, PortfolioNeed>();

  for (const row of needRows) {
    needCountByProject.set(
      row.projectId,
      (needCountByProject.get(row.projectId) ?? 0) + 1,
    );
    if (!firstNeedByProject.has(row.projectId)) {
      firstNeedByProject.set(row.projectId, {
        runId: row.runId,
        prompt: row.prompt,
        agent: row.agent as AgentRole,
        branch: row.branch,
      });
    }
  }

  let totalActiveWorkspaces = 0;
  let totalNeeds = 0;

  const enriched: PortfolioProject[] = visibleProjects.map((p, idx) => {
    const members = membersByProject.get(p.id) ?? [];
    const humansCount = members.length;
    const activeWorkspaces = workspacesByProject.get(p.id) ?? [];
    const agentSet = new Set<AgentRole>();

    for (const ws of activeWorkspaces) {
      if (ws.agent === "claude" || ws.agent === "codex") agentSet.add(ws.agent);
    }
    const agents = [...agentSet];
    const defaultExecutorId = defaultExecutorByProject.get(p.id) ?? null;
    const defaultAgent = defaultExecutorId
      ? (agentByExecutorId.get(defaultExecutorId) ?? null)
      : null;
    const pendingHitlCount = needCountByProject.get(p.id) ?? 0;

    totalActiveWorkspaces += activeWorkspaces.length;
    totalNeeds += pendingHitlCount;

    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      accent: ACCENTS[idx % ACCENTS.length],
      status: activeWorkspaces.some((ws) => ws.status === "running")
        ? "running"
        : "idle",
      defaultAgent,
      flowsCount: flowsCountByProject.get(p.id) ?? 0,
      backlogCount: backlogByProject.get(p.id) ?? 0,
      pendingHitlCount,
      humansCount,
      agentsCount: agents.length,
      members,
      agents,
      activeWorkspaces,
      recentMerges: mergesByProject.get(p.id) ?? [],
      need: firstNeedByProject.get(p.id) ?? null,
    };
  });

  return {
    projects: enriched,
    totalActiveWorkspaces,
    totalNeeds,
  };
}

export interface RailWorkspaceData {
  name: string;
  meta: string;
  status: WorkspaceStatus;
  time: string;
  href?: string;
}

export async function getRailWorkspaces(
  userId: string,
  globalRole: GlobalRole,
): Promise<RailWorkspaceData[]> {
  const now = new Date();
  const client = db();

  const base = client
    .select({
      branch: workspaces.branch,
      slug: projects.slug,
      agent: executors.agent,
      status: runs.status,
      startedAt: runs.startedAt,
      runId: runs.id,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(executors, eq(executors.id, runs.executorId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id));

  const rows =
    globalRole === "admin"
      ? await base
          .where(
            and(
              inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
              isNull(workspaces.removedAt),
            ),
          )
          .orderBy(desc(runs.startedAt))
          .limit(8)
      : await base
          .innerJoin(
            projectMembers,
            and(
              eq(projectMembers.projectId, runs.projectId),
              eq(projectMembers.userId, userId),
            ),
          )
          .where(
            and(
              inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
              isNull(workspaces.removedAt),
            ),
          )
          .orderBy(desc(runs.startedAt))
          .limit(8);

  return rows.map((row) => ({
    name: row.branch,
    meta: `${row.slug} · ${row.agent}`,
    status: runStatusToWorkspace(row.status),
    time: relativeTime(row.startedAt, now),
    href: `/runs/${row.runId}`,
  }));
}
