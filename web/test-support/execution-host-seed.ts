import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import * as fullSchema from "@/lib/db/schema";

// Minimal rows for execution-host tests: one project, one run, one registered
// local host. Kept deliberately narrow — assignment/command tests must not
// depend on the flow/task seed chain.
// FIXME(any): drizzle duplicate peer copies — same cast as graph-run-seed.ts.
const schema = fullSchema as unknown as Record<string, any>;

export async function seedProject(db: NodePgDatabase): Promise<string> {
  const projectId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `eh-${short}`,
    name: `EH ${short}`,
    repoPath: `/tmp/eh-${short}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `E${short.slice(0, 5).toUpperCase()}`,
  });

  return projectId;
}

export async function seedRun(
  db: NodePgDatabase,
  input: { projectId: string; status?: string; runKind?: string } = {
    projectId: "",
  },
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId: input.projectId || null,
    runKind: input.runKind ?? "scratch",
    status: input.status ?? "Running",
    flowVersion: "scratch",
    flowRevision: "manual",
  });

  return runId;
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
