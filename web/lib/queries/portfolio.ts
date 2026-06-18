import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type {
  GlobalRole,
  ProjectRole,
  RunKind,
  ScratchDialogStatus,
} from "@/lib/db/schema";
import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { HitlItem } from "@/lib/queries/hitl";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { deriveTtlInfo } from "@/lib/gc/ttl";
import { gcAgeDays, gcWarningDays } from "@/lib/instance-config";
import { mapRowsToHitlItems } from "@/lib/queries/hitl";
import { resolveStages } from "@/lib/queries/hitl-stage";
import * as schema from "@/lib/db/schema";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";
import {
  deriveWorkbenchLifecycleActions,
  type WorkbenchLifecycleActionId,
  type WorkbenchRunStatus,
} from "@/lib/workbench-lifecycle/policy";

const {
  actorIdentities,
  assignments,
  flows,
  hitlRequests,
  platformAcpRunners,
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
const ACTIONABLE_ASSIGNMENT_RUN_STATUSES = [
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "Review",
] as const;

// M19 Phase 5: terminal run statuses whose surviving workspace still shows a GC
// removal countdown in the left rail until the sweeper prunes it.
export const RAIL_TTL_STATUSES = ["Abandoned", "Done"] as const;

export type PortfolioStatus = "running" | "idle";
export type AgentRole = AdapterId | "dev";
export type WorkspaceStatus = "running" | "needs" | "queued" | "done";
export type ScratchWorkspaceAction = "open" | "recover" | "discard" | "none";
export type WorkbenchLifecycleAction = WorkbenchLifecycleActionId;

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
  // M34: standalone agent-run identity — the catalog agent id and the
  // trigger that fired it; null on flow/scratch rows.
  agentId: string | null;
  triggerSource: string | null;
  agent: AgentRole;
  status: WorkspaceStatus;
  time: string;
  href: string;
  scratchDialogStatus?: ScratchDialogStatus | null;
  scratchAction?: ScratchWorkspaceAction;
  lifecycleActions: WorkbenchLifecycleAction[];
  // T16 (M15, ADR-048): unified readiness summary for the active workspace,
  // replacing the M16 externalGatePending boolean. Computed per active run over
  // the same bulk-fetched gate_results + artifact_instances + node_attempts via
  // readiness-core.ts (the SSOT shared with board.ts/getRunReadiness/
  // assertEvidenceReady) — byte-equivalent classification, no per-run
  // getRunReadiness, no N+1. Done/Abandoned runs aren't active here so always
  // read "ready" (mirrors board.ts done-zeroing).
  readiness: ReadinessState;
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
  // ADR-093 (invariant D): derived signal that the project's config lives only
  // in the DB (registered with no maister.yaml). The raw path is never exposed
  // to the client (owner 2026-06-17) — only this boolean drives the home banner.
  needsPersist: boolean;
}

export interface Portfolio {
  projects: PortfolioProject[];
  totalActiveWorkspaces: number;
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
  // M19: a Crashed flow (graph) run gains the same recover/discard affordance
  // scratch runs already had — `recover` when a checkpoint handle survives,
  // else `discard`. Non-crashed flow runs surface no action (`none`). The
  // session id is consumed here as a presence check only — never returned.
  if (input.runKind !== "scratch") {
    if (input.runStatus === "Crashed") {
      return input.acpSessionId ? "recover" : "discard";
    }

    return "none";
  }
  if (input.dialogStatus === "Review") return "open";
  if (input.runStatus === "Crashed") {
    return input.acpSessionId ? "recover" : "discard";
  }
  if (input.dialogStatus === "Done" || input.dialogStatus === "Abandoned") {
    return "none";
  }

  return "open";
}

export function lifecycleActionsForWorkspace(input: {
  runKind: RunKind;
  runStatus: string;
  dialogStatus: ScratchDialogStatus | null;
  hasWorkspace: boolean;
  removedAt: Date | null;
  archivedBranch: string | null;
}): WorkbenchLifecycleAction[] {
  return deriveWorkbenchLifecycleActions({
    runKind: input.runKind,
    runStatus: input.runStatus as WorkbenchRunStatus,
    scratchDialogStatus: input.dialogStatus,
    hasWorkspace: input.hasWorkspace,
    workspaceRemoved: input.removedAt !== null,
    workspaceArchived: input.archivedBranch !== null,
  })
    .filter((action) => action.enabled)
    .map((action) => action.id);
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
            defaultRunnerId: projects.defaultRunnerId,
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
    return { projects: [], totalActiveWorkspaces: 0 };
  }

  const projectIds = visibleProjects.map((p) => p.id);

  const [
    memberRows,
    flowCountRows,
    backlogRows,
    activeRunRows,
    recentMergeRows,
    needRows,
    legacyNeedRows,
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

    // M34: leftJoin — none/repo_read agent runs have NO workspaces row but
    // still belong in the active grid (the IS NULL filter passes on the
    // absent row).
    client
      .select({
        runId: runs.id,
        projectId: runs.projectId,
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
          inArray(runs.projectId, projectIds),
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

    client
      .select({
        runId: runs.id,
        projectId: runs.projectId,
        capabilityAgent: runs.capabilityAgent,
        runnerSnapshot: runs.runnerSnapshot,
        branch: workspaces.branch,
        endedAt: runs.endedAt,
      })
      .from(runs)
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
        projectId: assignments.projectId,
        runId: runs.id,
        prompt: assignments.title,
        capabilityAgent: runs.capabilityAgent,
        runnerSnapshot: runs.runnerSnapshot,
        branch: workspaces.branch,
        createdAt: assignments.createdAt,
        runStatus: runs.status,
      })
      .from(assignments)
      .innerJoin(runs, eq(runs.id, assignments.runId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(
        and(
          inArray(assignments.projectId, projectIds),
          inArray(assignments.status, ["open", "claimed"]),
          inArray(runs.status, [...ACTIONABLE_ASSIGNMENT_RUN_STATUSES]),
          isNull(workspaces.removedAt),
        ),
      )
      .orderBy(desc(assignments.createdAt)),

    client
      .select({
        projectId: runs.projectId,
        runId: runs.id,
        prompt: hitlRequests.prompt,
        capabilityAgent: runs.capabilityAgent,
        runnerSnapshot: runs.runnerSnapshot,
        branch: workspaces.branch,
        createdAt: hitlRequests.createdAt,
        runStatus: runs.status,
      })
      .from(hitlRequests)
      .innerJoin(runs, eq(runs.id, hitlRequests.runId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(
        and(
          inArray(runs.projectId, projectIds),
          inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
          isNull(hitlRequests.respondedAt),
          isNull(workspaces.removedAt),
        ),
      )
      .orderBy(desc(hitlRequests.createdAt)),
  ]);

  const defaultAgentRows = await client
    .select({
      agent: platformAcpRunners.capabilityAgent,
      id: platformAcpRunners.id,
    })
    .from(platformAcpRunners);

  const defaultRunnerByProject = new Map<string, string | null>();

  for (const p of visibleProjects) {
    defaultRunnerByProject.set(p.id, p.defaultRunnerId ?? null);
  }
  const agentByRunnerId = new Map<string, AgentRole>();

  for (const row of defaultAgentRows) {
    agentByRunnerId.set(row.id, row.agent as AgentRole);
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

  // T16 (M15, ADR-048): the unified readiness state per active run, replacing
  // the M16 externalGatePending boolean, via the shared computeReadinessByRun
  // (readiness-batch) — the same classifier the board and project pages use,
  // no per-run getRunReadiness call, no N+1.
  const activeRunIds = activeRunRows.map((r) => r.runId);
  const readinessByRun = await computeReadinessByRun(client, activeRunIds);

  const workspacesByProject = new Map<string, PortfolioWorkspace[]>();

  for (const row of activeRunRows) {
    const list = workspacesByProject.get(row.projectId) ?? [];

    // A claimed run is human-driven, not agent-driven — surface the `dev` pill
    // instead of the run's executor agent (mirrors lib/board.ts takeover cards).
    const agent: AgentRole =
      row.status === "HumanWorking"
        ? "dev"
        : runnerAgentFromFields({
            capabilityAgent: row.capabilityAgent,
            runnerSnapshot: row.runnerSnapshot,
            context: row.runId,
          });

    list.push({
      runId: row.runId,
      runKind: row.runKind as RunKind,
      branch: row.branch ?? row.agentId ?? "—",
      agentId: row.agentId ?? null,
      triggerSource: row.triggerSource ?? null,
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
      lifecycleActions: lifecycleActionsForWorkspace({
        runKind: row.runKind as RunKind,
        runStatus: row.status,
        dialogStatus: row.scratchDialogStatus as ScratchDialogStatus | null,
        hasWorkspace: Boolean(row.workspaceId),
        removedAt: row.removedAt,
        archivedBranch: row.archivedBranch,
      }),
      // ACTIVE_RUN_STATUSES excludes Done/Abandoned, so every workspace here is
      // non-terminal; a run with no gates/artifacts rolls up to "ready".
      readiness: readinessByRun.get(row.runId) ?? "ready",
    });
    workspacesByProject.set(row.projectId, list);
  }

  const mergesByProject = new Map<string, PortfolioRecentMerge[]>();

  for (const row of recentMergeRows) {
    const list = mergesByProject.get(row.projectId) ?? [];

    if (list.length >= 2) continue;
    list.push({
      branch: row.branch,
      agent: runnerAgentFromFields({
        capabilityAgent: row.capabilityAgent,
        runnerSnapshot: row.runnerSnapshot,
        context: row.runId,
      }),
      time: row.endedAt ? relativeTime(row.endedAt, now) : "—",
    });
    mergesByProject.set(row.projectId, list);
  }

  const needCountByProject = new Map<string, number>();
  const firstNeedByProject = new Map<string, PortfolioNeed>();
  const assignmentNeedRunIds = new Set(needRows.map((row) => row.runId));
  const effectiveNeedRows = [
    ...needRows,
    ...legacyNeedRows.filter((row) => !assignmentNeedRunIds.has(row.runId)),
  ];

  for (const row of effectiveNeedRows) {
    needCountByProject.set(
      row.projectId,
      (needCountByProject.get(row.projectId) ?? 0) + 1,
    );
    if (!firstNeedByProject.has(row.projectId)) {
      firstNeedByProject.set(row.projectId, {
        runId: row.runId,
        prompt: row.prompt,
        agent:
          row.runStatus === "HumanWorking"
            ? "dev"
            : runnerAgentFromFields({
                capabilityAgent: row.capabilityAgent,
                runnerSnapshot: row.runnerSnapshot,
                context: row.runId,
              }),
        branch: row.branch,
      });
    }
  }

  let totalActiveWorkspaces = 0;

  const enriched: PortfolioProject[] = visibleProjects.map((p, idx) => {
    const members = membersByProject.get(p.id) ?? [];
    const humansCount = members.length;
    const activeWorkspaces = workspacesByProject.get(p.id) ?? [];
    const agentSet = new Set<AgentRole>();

    for (const ws of activeWorkspaces) {
      if (ws.agent === "claude" || ws.agent === "codex") agentSet.add(ws.agent);
    }
    const agents = [...agentSet];
    const defaultRunnerId = defaultRunnerByProject.get(p.id) ?? null;
    const defaultAgent = defaultRunnerId
      ? (agentByRunnerId.get(defaultRunnerId) ?? null)
      : null;
    const pendingHitlCount = needCountByProject.get(p.id) ?? 0;

    totalActiveWorkspaces += activeWorkspaces.length;

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
      needsPersist: p.maisterYamlPath === null,
    };
  });

  return {
    projects: enriched,
    totalActiveWorkspaces,
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

export type RailTtlState = "active" | "warning" | "due";

// Runner detail for the rail row's runner info chip tooltip
// (agent · model · adapter · provider · sidecar). Parsed null-safe from
// runs.runner_snapshot — a missing snapshot yields null and the chip hides.
// Never carries the snapshot id, argv, or secret refs.
export interface RailRunnerDetail {
  agent: string;
  model: string;
  adapter: string;
  provider: string;
  sidecar: string | null;
}

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
  // M19 Phase 5: GC TTL projection for the left-rail removal-countdown badge.
  // Derived from deriveTtlInfo — DTO-only enums/booleans/Date, never raw
  // session ids or worktree paths.
  ttlState: RailTtlState;
  effectiveRemovalAt: Date | null;
  archived: boolean;
  pruned: boolean;
  lifecycleActions: WorkbenchLifecycleAction[];
  // Active-workspaces redesign: ticket-derived identity + linked flow/issue
  // chips + runner tooltip. All null-safe: no task hides the issue chip and
  // falls the name back to the branch, no flow hides the flow chip, no runner
  // snapshot hides the runner chip.
  flowRefLabel: string | null;
  flowVersion: string | null;
  taskKey: string | null;
  taskNumber: number | null;
  issueHref: string | null;
  runnerDetail: RailRunnerDetail | null;
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
  // M19 Phase 5: terminal workspaces awaiting GC surface their own (dimmed)
  // status so they read as "winding down", not "Running".
  if (input.runStatus === "Abandoned" || input.runStatus === "Done") {
    return { label: input.runStatus, tone: "review" };
  }

  return { label: "Running", tone: "running" };
}

function executorDisplay(row: {
  capabilityAgent: string | null;
  runnerSnapshot: {
    id: string;
    capabilityAgent: string;
    model: string;
    adapter: string;
    providerKind: string;
    permissionPolicy: string;
    sidecarId?: string | null;
  } | null;
  runId: string;
}): string {
  const agent = runnerAgentFromFields({
    capabilityAgent: row.capabilityAgent,
    runnerSnapshot: row.runnerSnapshot,
    context: row.runId,
  });
  const ref = row.runnerSnapshot?.id ?? null;
  const model = row.runnerSnapshot?.model ?? null;

  if (ref === null || model === null) {
    throw new MaisterError(
      "PRECONDITION",
      `Run ${row.runId} has no runner snapshot label`,
    );
  }

  return `${ref} · ${agent} · ${model}`;
}

function creatorDisplay(
  row: { name: string | null; email: string | null } | undefined,
): string | null {
  if (!row) return null;

  return row.name ?? row.email ?? null;
}

// Ticket-derived display name for flow / agent runs: `KEY-N title`, or `KEY-N`
// when the task has no title. Returns null when the run resolves no task (the
// caller then falls the name back to the branch).
function ticketName(
  taskKey: string,
  taskNumber: number | null,
  title: string | null,
): string | null {
  if (taskNumber === null) return null;

  const key = `${taskKey}-${taskNumber}`;

  return title ? `${key} ${title}` : key;
}

export async function getRailWorkspaceGroups(
  userId: string,
  globalRole: GlobalRole,
): Promise<RailWorkspaceGroup[]> {
  const now = new Date();
  const client = db();

  const base = client
    .select({
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      projectId: projects.id,
      slug: projects.slug,
      projectName: projects.name,
      taskKey: projects.taskKey,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
      status: runs.status,
      runKind: runs.runKind,
      createdByUserId: runs.createdByUserId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      runId: runs.id,
      flowVersion: runs.flowVersion,
      flowRefId: flows.flowRefId,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      scratchName: scratchRuns.name,
      scratchDialogStatus: scratchRuns.dialogStatus,
      scratchCreatedByUserId: scratchRuns.createdByUserId,
      scheduledRemovalAt: workspaces.scheduledRemovalAt,
      archivedBranch: workspaces.archivedBranch,
      removedAt: workspaces.removedAt,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .leftJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
    // The run's task is runs.task_id (flow/agent) or scratch_runs.linked_task_id
    // (scratch) — coalesce so exactly one task row can match (single FK each side).
    .leftJoin(
      tasks,
      eq(tasks.id, sql`coalesce(${runs.taskId}, ${scratchRuns.linkedTaskId})`),
    )
    .leftJoin(flows, eq(flows.id, runs.flowId));

  // Rail = active workspaces PLUS terminal (Abandoned/Done) workspaces still on
  // disk that carry a GC removal deadline, so the TTL countdown badge surfaces
  // before the sweeper prunes them.
  const railFilter = and(
    or(
      inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
      and(
        inArray(runs.status, [...RAIL_TTL_STATUSES]),
        isNotNull(workspaces.scheduledRemovalAt),
      ),
    ),
    isNull(workspaces.removedAt),
  );

  const rows =
    globalRole === "admin"
      ? await base.where(railFilter).orderBy(desc(runs.startedAt))
      : await base
          .innerJoin(
            projectMembers,
            and(
              eq(projectMembers.projectId, runs.projectId),
              eq(projectMembers.userId, userId),
            ),
          )
          .where(railFilter)
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
  const nowMs = now.getTime();
  const ageDays = gcAgeDays();
  const warningDays = gcWarningDays();

  for (const row of rows) {
    const status = railStatus({
      runStatus: row.status,
      runKind: row.runKind as RunKind,
      scratchDialogStatus:
        row.scratchDialogStatus as ScratchDialogStatus | null,
    });
    const ttl = deriveTtlInfo({
      status: row.status,
      endedAt: row.endedAt,
      scheduledRemovalAt: row.scheduledRemovalAt,
      archivedBranch: row.archivedBranch,
      removedAt: row.removedAt,
      nowMs,
      ageDays,
      warningDays,
    });
    const creatorId = row.createdByUserId ?? row.scratchCreatedByUserId;
    const ticket = ticketName(row.taskKey, row.taskNumber, row.taskTitle);
    const hasTask = row.taskNumber !== null;
    const runnerDetail: RailRunnerDetail | null = row.runnerSnapshot
      ? {
          agent: row.runnerSnapshot.capabilityAgent,
          model: row.runnerSnapshot.model,
          adapter: row.runnerSnapshot.adapter,
          provider: row.runnerSnapshot.providerKind,
          sidecar: row.runnerSnapshot.sidecarId ?? null,
        }
      : null;
    const workspace: RailWorkspaceRow = {
      runId: row.runId,
      runKind: row.runKind as RunKind,
      name: row.scratchName ?? ticket ?? row.branch,
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
      ttlState: ttl.ttlState,
      effectiveRemovalAt: ttl.effectiveRemovalAt,
      archived: ttl.archived,
      pruned: ttl.pruned,
      lifecycleActions: lifecycleActionsForWorkspace({
        runKind: row.runKind as RunKind,
        runStatus: row.status,
        dialogStatus: row.scratchDialogStatus as ScratchDialogStatus | null,
        hasWorkspace: Boolean(row.workspaceId),
        removedAt: row.removedAt,
        archivedBranch: row.archivedBranch,
      }),
      flowRefLabel: row.flowRefId ?? null,
      flowVersion: row.flowRefId !== null ? row.flowVersion : null,
      taskKey: hasTask ? row.taskKey : null,
      taskNumber: row.taskNumber,
      issueHref: hasTask
        ? `/projects/${row.slug}/tasks/${row.taskNumber}`
        : null,
      runnerDetail,
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

export type CrossProjectHitlItem = HitlItem & {
  projectId: string;
  projectSlug: string;
  projectName: string;
};

export interface CrossProjectHitlInbox {
  items: CrossProjectHitlItem[];
  count: number;
}

const CRITICALITY_RANK: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

function critRank(c: string | null): number {
  return c !== null ? (CRITICALITY_RANK[c] ?? -1) : -1;
}

export async function getCrossProjectHitlInbox(
  userId: string,
  globalRole: GlobalRole,
): Promise<CrossProjectHitlInbox> {
  const now = new Date();
  const client = db();

  // Resolve visible projects exactly like getPortfolio.
  const visibleProjects =
    globalRole === "admin"
      ? await client
          .select({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
          })
          .from(projects)
          .where(isNull(projects.archivedAt))
      : await client
          .select({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
          })
          .from(projects)
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(
            and(eq(projectMembers.userId, userId), isNull(projects.archivedAt)),
          );

  if (visibleProjects.length === 0) {
    return { items: [], count: 0 };
  }

  const projectIds = visibleProjects.map((p) => p.id);

  // One batched query: all pending hitl_requests across all visible run ids.
  const rows = await client
    .select({
      hitlRequestId: hitlRequests.id,
      runId: hitlRequests.runId,
      kind: hitlRequests.kind,
      prompt: hitlRequests.prompt,
      rawSchema: hitlRequests.schema,
      criticality: hitlRequests.criticality,
      createdAt: hitlRequests.createdAt,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
      branch: workspaces.branch,
      flowRef: flows.flowRefId,
      projectId: runs.projectId,
      taskNumber: tasks.number,
      taskKey: projects.taskKey,
      taskTitle: tasks.title,
      stepId: hitlRequests.stepId,
      flowRevisionId: runs.flowRevisionId,
      flowId: runs.flowId,
    })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(
      and(
        inArray(runs.projectId, projectIds),
        inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
        isNull(hitlRequests.respondedAt),
      ),
    )
    .orderBy(asc(hitlRequests.createdAt));

  if (rows.length === 0) {
    return { items: [], count: 0 };
  }

  // Batched assignment + actor lookups (no N+1).
  const hitlIds = rows.map((row) => row.hitlRequestId);
  const assignmentRows = await client
    .select()
    .from(assignments)
    .where(inArray(assignments.hitlRequestId, hitlIds));

  const actorIds = assignmentRows
    .map((a) => a.assigneeActorId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const actorRows =
    actorIds.length > 0
      ? await client
          .select({
            id: actorIdentities.id,
            label: actorIdentities.label,
            userId: actorIdentities.userId,
          })
          .from(actorIdentities)
          .where(inArray(actorIdentities.id, actorIds))
      : [];

  const actorsById = new Map(actorRows.map((a) => [a.id, a]));
  const assignmentsByHitlId = new Map(
    assignmentRows.map((a) => [a.hitlRequestId, a]),
  );

  // Build project lookup for slug/name.
  const projectById = new Map(
    visibleProjects.map((p) => [p.id, { slug: p.slug, name: p.name }]),
  );

  const stagesByHitlId = await resolveStages(client, rows);
  const baseItems = mapRowsToHitlItems(
    rows,
    assignmentsByHitlId,
    actorsById,
    stagesByHitlId,
    now,
  );

  const items: CrossProjectHitlItem[] = baseItems.map((item, idx) => {
    const projId = rows[idx].projectId;
    const proj = projectById.get(projId) ?? { slug: projId, name: projId };

    return {
      ...item,
      projectId: projId,
      projectSlug: proj.slug,
      projectName: proj.name,
    };
  });

  // Sort: criticality DESC (critical>high>medium>low>null), then createdAt ASC (already asc from DB).
  items.sort((a, b) => {
    const rankDiff = critRank(b.criticality) - critRank(a.criticality);

    return rankDiff !== 0 ? rankDiff : 0; // createdAt order already preserved from DB
  });

  // `count` is the size of THIS inbox list — pending hitl_requests rows in
  // NeedsInput/NeedsInputIdle. It is intentionally narrower than
  // getPortfolio.totalNeeds (the actionable-ASSIGNMENT total, which also counts
  // HumanWorking/Review runs): the home "needs you" headline reflects
  // totalNeeds, while this `count` titles the HITL inbox block specifically.
  return { items, count: items.length };
}
