import "server-only";

import type {
  GlobalRole,
  ProjectRole,
  RunKind,
  ScratchDialogStatus,
} from "@/lib/db/schema";
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
  scratchRuns,
  tasks,
  users,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export const ACTIVE_RUN_STATUSES = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "Review",
  "Crashed",
  // M11b (ADR-030): a claimed run (manual takeover) is session-less yet holds a
  // worktree + a concurrency slot, so it counts as an active workspace —
  // mirroring lib/board.ts (which buckets HumanWorking into the in-flight set).
  "HumanWorking",
] as const;

export type PortfolioStatus = "running" | "idle";
export type AgentRole = "claude" | "codex" | "dev";
export type WorkspaceStatus = "running" | "needs" | "queued" | "done";
export type ScratchWorkspaceAction = "open" | "recover" | "discard" | "none";

export interface PortfolioMember {
  initials: string;
  name: string;
  role: ProjectRole;
  isAdmin: boolean;
}

export interface PortfolioWorkspace {
  runId: string;
  runKind: RunKind;
  branch: string;
  agent: AgentRole;
  status: WorkspaceStatus;
  time: string;
  href: string;
  scratchDialogStatus?: ScratchDialogStatus | null;
  scratchAction?: ScratchWorkspaceAction;
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

export function relativeTime(from: Date, now: Date): string {
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

export function runStatusToWorkspace(status: string): WorkspaceStatus {
  if (status === "Running") return "running";
  // HumanWorking is a human-in-the-loop claimed state; surface it like NeedsInput.
  if (
    status === "NeedsInput" ||
    status === "NeedsInputIdle" ||
    status === "WaitingForUser" ||
    status === "HumanWorking"
  ) {
    return "needs";
  }
  if (status === "Pending") return "queued";

  return "done";
}

export function scratchActionForWorkspace(input: {
  runKind: RunKind;
  runStatus: string;
  dialogStatus: ScratchDialogStatus | null;
  acpSessionId: string | null;
}): ScratchWorkspaceAction {
  if (input.runKind !== "scratch") return "none";
  if (input.dialogStatus === "Review") return "open";
  if (input.runStatus === "Crashed") {
    return input.acpSessionId ? "recover" : "discard";
  }
  if (input.dialogStatus === "Done" || input.dialogStatus === "Abandoned") {
    return "none";
  }

  return "open";
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
        runId: runs.id,
        projectId: runs.projectId,
        status: runs.status,
        runKind: runs.runKind,
        acpSessionId: runs.acpSessionId,
        agent: executors.agent,
        branch: workspaces.branch,
        startedAt: runs.startedAt,
        scratchDialogStatus: scratchRuns.dialogStatus,
      })
      .from(runs)
      .innerJoin(executors, eq(executors.id, runs.executorId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .leftJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
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

    // A claimed run is human-driven, not agent-driven — surface the `dev` pill
    // instead of the run's executor agent (mirrors lib/board.ts takeover cards).
    const agent: AgentRole =
      row.status === "HumanWorking" ? "dev" : (row.agent as AgentRole);

    list.push({
      runId: row.runId,
      runKind: row.runKind as RunKind,
      branch: row.branch,
      agent,
      status: runStatusToWorkspace(row.status),
      time: relativeTime(row.startedAt, now),
      href:
        row.runKind === "scratch"
          ? `/scratch-runs/${row.runId}`
          : `/runs/${row.runId}`,
      scratchDialogStatus:
        row.scratchDialogStatus as ScratchDialogStatus | null,
      scratchAction: scratchActionForWorkspace({
        runKind: row.runKind as RunKind,
        runStatus: row.status,
        dialogStatus: row.scratchDialogStatus as ScratchDialogStatus | null,
        acpSessionId: row.acpSessionId,
      }),
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

export type RailWorkspaceTone =
  | "running"
  | "waiting"
  | "needs"
  | "human"
  | "review"
  | "crashed";

export interface RailWorkspaceRow {
  runId: string;
  runKind: RunKind;
  name: string;
  branch: string;
  executorLabel: string;
  launchedBy: string | null;
  statusLabel: string;
  statusTone: RailWorkspaceTone;
  time: string;
  href: string;
  latestActivityAt: Date;
}

export interface RailWorkspaceGroup {
  projectId: string;
  projectSlug: string;
  projectName: string;
  activeCount: number;
  latestActivityAt: Date;
  launchHref: string;
  workspaces: RailWorkspaceRow[];
}

function railStatus(input: {
  runStatus: string;
  runKind: RunKind;
  scratchDialogStatus: ScratchDialogStatus | null;
}): { label: string; tone: RailWorkspaceTone } {
  if (
    input.runKind === "scratch" &&
    input.scratchDialogStatus === "WaitingForUser"
  ) {
    return { label: "WaitingForUser", tone: "waiting" };
  }
  if (input.runStatus === "HumanWorking") {
    return { label: "HumanWorking", tone: "human" };
  }
  if (
    input.runStatus === "NeedsInput" ||
    input.runStatus === "NeedsInputIdle"
  ) {
    return { label: input.runStatus, tone: "needs" };
  }
  if (input.runStatus === "Review") return { label: "Review", tone: "review" };
  if (input.runStatus === "Crashed") {
    return { label: "Crashed", tone: "crashed" };
  }

  return { label: "Running", tone: "running" };
}

function executorDisplay(row: {
  agent: string;
  model: string;
  executorRefId: string;
}): string {
  return `${row.executorRefId} · ${row.agent} · ${row.model}`;
}

function creatorDisplay(
  row: { name: string | null; email: string | null } | undefined,
): string | null {
  if (!row) return null;

  return row.name ?? row.email ?? null;
}

export async function getRailWorkspaceGroups(
  userId: string,
  globalRole: GlobalRole,
): Promise<RailWorkspaceGroup[]> {
  const now = new Date();
  const client = db();

  const base = client
    .select({
      branch: workspaces.branch,
      projectId: projects.id,
      slug: projects.slug,
      projectName: projects.name,
      agent: executors.agent,
      model: executors.model,
      executorRefId: executors.executorRefId,
      status: runs.status,
      runKind: runs.runKind,
      createdByUserId: runs.createdByUserId,
      startedAt: runs.startedAt,
      runId: runs.id,
      scratchName: scratchRuns.name,
      scratchDialogStatus: scratchRuns.dialogStatus,
      scratchCreatedByUserId: scratchRuns.createdByUserId,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(executors, eq(executors.id, runs.executorId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .leftJoin(scratchRuns, eq(scratchRuns.runId, runs.id));

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
          .orderBy(desc(runs.startedAt));

  const creatorIds = [
    ...new Set(
      rows
        .map((row) => row.createdByUserId ?? row.scratchCreatedByUserId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const creatorRows =
    creatorIds.length > 0
      ? await client
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : [];
  const creators = new Map(creatorRows.map((row) => [row.id, row]));
  const groups = new Map<string, RailWorkspaceGroup>();

  for (const row of rows) {
    const status = railStatus({
      runStatus: row.status,
      runKind: row.runKind as RunKind,
      scratchDialogStatus:
        row.scratchDialogStatus as ScratchDialogStatus | null,
    });
    const creatorId = row.createdByUserId ?? row.scratchCreatedByUserId;
    const workspace: RailWorkspaceRow = {
      runId: row.runId,
      runKind: row.runKind as RunKind,
      name: row.scratchName ?? row.branch,
      branch: row.branch,
      executorLabel: executorDisplay(row),
      launchedBy: creatorDisplay(
        creatorId ? creators.get(creatorId) : undefined,
      ),
      statusLabel: status.label,
      statusTone: status.tone,
      time: relativeTime(row.startedAt, now),
      href:
        row.runKind === "scratch"
          ? `/scratch-runs/${row.runId}`
          : `/runs/${row.runId}`,
      latestActivityAt: row.startedAt,
    };
    const group =
      groups.get(row.projectId) ??
      ({
        projectId: row.projectId,
        projectSlug: row.slug,
        projectName: row.projectName,
        activeCount: 0,
        latestActivityAt: row.startedAt,
        launchHref: `/scratch-runs/new?projectId=${row.projectId}`,
        workspaces: [],
      } satisfies RailWorkspaceGroup);

    group.workspaces.push(workspace);
    group.activeCount += 1;
    if (row.startedAt > group.latestActivityAt) {
      group.latestActivityAt = row.startedAt;
    }
    groups.set(row.projectId, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      workspaces: group.workspaces.sort(
        (a, b) => b.latestActivityAt.getTime() - a.latestActivityAt.getTime(),
      ),
    }))
    .sort((a, b) => {
      const timeDiff =
        b.latestActivityAt.getTime() - a.latestActivityAt.getTime();

      return timeDiff === 0
        ? a.projectName.localeCompare(b.projectName)
        : timeDiff;
    });
}

export async function getRailWorkspaces(
  userId: string,
  globalRole: GlobalRole,
): Promise<RailWorkspaceData[]> {
  const groups = await getRailWorkspaceGroups(userId, globalRole);

  return groups.flatMap((group) =>
    group.workspaces.map((row) => ({
      name: row.name,
      meta: `${group.projectSlug} · ${row.runKind === "scratch" ? "scratch" : row.executorLabel}`,
      status: runStatusToWorkspace(row.statusLabel),
      time: row.time,
      href: row.href,
    })),
  );
}
