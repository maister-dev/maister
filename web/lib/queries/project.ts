import "server-only";

import type { Project } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { asc, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { executors, flows, projectMembers, projects, users } = schema;

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

  const [flowRows, executorRows, memberRows] = await Promise.all([
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
  ]);

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

  const defaultExecutor = project.defaultExecutorId
    ? projectExecutors.find((e) => e.id === project.defaultExecutorId)
    : undefined;

  return {
    project,
    flows: projectFlows,
    executors: projectExecutors,
    members,
    defaultAgent: defaultExecutor?.agent ?? null,
    defaultExecutorRef: defaultExecutor?.ref ?? null,
  };
}
