import "server-only";

import type { Project, RunKind, ScratchDialogStatus } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";
import {
  ACTIVE_RUN_STATUSES,
  type AgentRole,
  type PortfolioWorkspace,
  relativeTime,
  runStatusToWorkspace,
  scratchActionForWorkspace,
} from "@/lib/queries/portfolio";

const {
  executors,
  flows,
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

export type ProjectAgent = "claude" | "codex";

export interface ProjectFlow {
  id: string;
  ref: string;
  source: string;
  version: string;
  stepCount: number;
  overrideRef: string | null;
}

export interface ProjectExecutor {
  id: string;
  ref: string;
  agent: ProjectAgent;
  model: string;
  router: "ccr" | null;
}

export interface ProjectMemberView {
  initials: string;
  name: string;
  isAdmin: boolean;
}

export interface ProjectPageData {
  project: Project;
  flows: ProjectFlow[];
  executors: ProjectExecutor[];
  members: ProjectMemberView[];
  activeWorkspaces: PortfolioWorkspace[];
  defaultAgent: ProjectAgent | null;
  defaultExecutorRef: string | null;
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
  const [flowRows, executorRows, memberRows, activeRunRows] = await Promise.all(
    [
      client
        .select({
          id: flows.id,
          ref: flows.flowRefId,
          source: flows.source,
          version: flows.version,
          manifest: flows.manifest,
          overrideId: flows.executorOverrideId,
        })
        .from(flows)
        .where(eq(flows.projectId, project.id))
        .orderBy(asc(flows.createdAt)),

      client
        .select({
          id: executors.id,
          ref: executors.executorRefId,
          agent: executors.agent,
          model: executors.model,
          router: executors.router,
        })
        .from(executors)
        .where(eq(executors.projectId, project.id))
        .orderBy(asc(executors.createdAt)),

      client
        .select({
          name: users.name,
          email: users.email,
          role: projectMembers.role,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(eq(projectMembers.projectId, project.id)),

      client
        .select({
          runId: runs.id,
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
            eq(runs.projectId, project.id),
            inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
            isNull(workspaces.removedAt),
          ),
        )
        .orderBy(desc(runs.startedAt)),
    ],
  );

  const refById = new Map(executorRows.map((e) => [e.id, e.ref]));

  const projectFlows: ProjectFlow[] = flowRows.map((f) => ({
    id: f.id,
    ref: f.ref,
    source: f.source,
    version: f.version,
    stepCount: stepCountOf(f.manifest),
    overrideRef: f.overrideId ? (refById.get(f.overrideId) ?? null) : null,
  }));

  const projectExecutors: ProjectExecutor[] = executorRows.map((e) => ({
    id: e.id,
    ref: e.ref,
    agent: e.agent,
    model: e.model,
    router: e.router,
  }));

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
    branch: row.branch,
    agent: row.agent as AgentRole,
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
    // ACTIVE_RUN_STATUSES excludes Done/Abandoned; a gate-less run → "ready".
    readiness: readinessByRun.get(row.runId) ?? "ready",
  }));

  const defaultExecutor = project.defaultExecutorId
    ? projectExecutors.find((e) => e.id === project.defaultExecutorId)
    : undefined;

  return {
    project,
    flows: projectFlows,
    executors: projectExecutors,
    members,
    activeWorkspaces,
    defaultAgent: defaultExecutor?.agent ?? null,
    defaultExecutorRef: defaultExecutor?.ref ?? null,
  };
}
