import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import * as fullSchema from "@/lib/db/schema";

// Minimal rows for execution-host tests: one project, one run, one registered
// local host, optionally a workspace / local package. Kept deliberately narrow
// — assignment/command tests must not depend on the flow/task seed chain.
// FIXME(any): drizzle duplicate peer copies — same cast as graph-run-seed.ts.
const schema = fullSchema as unknown as Record<string, any>;

export type SeededProject = { id: string; slug: string; repoPath: string };

export async function seedProjectRow(
  db: NodePgDatabase,
  input: { repoPath?: string; slug?: string } = {},
): Promise<SeededProject> {
  const projectId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);
  const slug = input.slug ?? `eh-${short}`;
  const repoPath = input.repoPath ?? `/tmp/eh-${short}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `EH ${short}`,
    repoPath,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `E${short.slice(0, 5).toUpperCase()}`,
  });

  return { id: projectId, slug, repoPath };
}

export async function seedProject(
  db: NodePgDatabase,
  input: { repoPath?: string; slug?: string } = {},
): Promise<string> {
  return (await seedProjectRow(db, input)).id;
}

export async function seedRun(
  db: NodePgDatabase,
  input: {
    projectId: string;
    id?: string;
    status?: string;
    runKind?: "flow" | "scratch" | "agent";
    agentWorkspace?: "none" | "repo_read" | "worktree";
    localPackageId?: string;
    contextMounts?: ContextMountSnapshot[];
    rootRunId?: string;
    workspaceMode?: "own" | "shared";
    executionDataPlaneMode?: "legacy_file_v1" | "canonical_events_v1";
  } = { projectId: "" },
): Promise<string> {
  const runId = input.id ?? randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId: input.projectId || null,
    runKind: input.runKind ?? "scratch",
    status: input.status ?? "Running",
    flowVersion: "scratch",
    flowRevision: "manual",
    agentWorkspace: input.agentWorkspace ?? null,
    localPackageId: input.localPackageId ?? null,
    contextMounts: input.contextMounts ?? null,
    rootRunId: input.rootRunId ?? null,
    workspaceMode: input.workspaceMode ?? null,
    executionDataPlaneMode: input.executionDataPlaneMode ?? "legacy_file_v1",
  });

  return runId;
}

export async function seedWorkspace(
  db: NodePgDatabase,
  input: {
    runId: string;
    projectId: string;
    worktreePath: string;
    parentRepoPath: string;
    branch?: string;
  },
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.workspaces).values({
    id,
    runId: input.runId,
    projectId: input.projectId,
    branch: input.branch ?? `maister/eh-${id.slice(0, 8)}`,
    worktreePath: input.worktreePath,
    parentRepoPath: input.parentRepoPath,
  });

  return id;
}

export async function seedLocalPackage(
  db: NodePgDatabase,
  input: { workingDir: string; name?: string; slug?: string },
): Promise<string> {
  const id = randomUUID();
  const short = id.replace(/-/g, "").slice(0, 8);

  await db.insert(schema.localPackages).values({
    id,
    name: input.name ?? `eh-pkg-${short}`,
    slug: input.slug ?? `eh-pkg-${short}`,
    workingDir: input.workingDir,
    status: "active",
  });

  return id;
}

export async function seedLocalHost(
  db: NodePgDatabase,
  input: { hostKey?: string; bootId?: string } = {},
): Promise<{ id: string; hostKey: string }> {
  const id = randomUUID();
  const hostKey = input.hostKey ?? `eh_${randomUUID().replace(/-/g, "")}`;

  await db.insert(schema.executionHosts).values({
    id,
    hostKey,
    kind: "local_direct",
    displayName: "test local host",
    transport: { kind: "local_direct" },
    capabilities: {
      protocolVersion: 1,
      supervisorVersion: "test",
      adapters: [],
    },
    readiness: "ready",
    lastBootId: input.bootId ?? randomUUID(),
    lastSeenAt: new Date(),
  });

  return { id, hostKey };
}
