import type { FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST as register } from "@/app/api/projects/route";
import { POST as launch } from "@/app/api/task-launch-intents/route";
import { confirmCapabilityTrust } from "@/lib/capabilities/import";
import {
  capabilityImports,
  flows,
  flowRunnerRemaps,
  platformAcpRunners,
  platformRuntimeSettings,
  projectDependencyAttempts,
  projectDependencyDeclarations,
  projectFlowRunnerDefaults,
  taskLaunchIntents,
  tasks,
} from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { serviceDependency } from "@/lib/project-dependencies/worker";
import { taskLaunchSettingsToken } from "@/lib/tasks/launch-resolution";
import { initRepo } from "@/test-support/git-fixture";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actorId = randomUUID();
const slug = `dependency-admission-${randomUUID().slice(0, 8)}`;
const runner = "ac05-codex";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireGlobalRole: async () => ({ id: actorId, role: "admin" }),
  requireActiveSession: async () => ({ id: actorId, role: "admin" }),
}));
vi.mock("@/lib/supervisor-client", async (original) => ({
  ...(await original<typeof import("@/lib/supervisor-client")>()),
  checkSupervisorHealth: async () => ({ kind: "available" }),
  listSessions: async () => [],
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "dependency_admission",
  });
  root = await mkdtempReal("dependency-admission-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", join(root, "runtime"));
  vi.stubEnv("MAISTER_WORKTREES_ROOT", join(root, "worktrees"));
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'admin','active',false)",
    [actorId, `${actorId}@test.invalid`],
  );
  await database.db
    .insert(platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runner,
        "codex",
      ) as typeof platformAcpRunners.$inferInsert,
    );
  await database.db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runner })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runner },
    });
  await fakeExecutionHosts(database.db);
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function createFlow(
  name: string,
  manifest: Pick<FlowYamlV1, "mcps" | "nodes">,
) {
  const dir = join(root, name);

  await mkdir(dir);
  await writeFile(
    join(dir, "flow.yaml"),
    JSON.stringify({
      schemaVersion: 1,
      name,
      compat: { engine_min: "1.1.0" },
      ...manifest,
    }),
  );

  return dir;
}

async function requestLaunch(projectId: string, flowRefId: string) {
  const db = database.db;
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.projectId, projectId), eq(flows.flowRefId, flowRefId)));
  const taskId = randomUUID();
  const [next] = (
    await database.pool.query<{ number: number }>(
      "SELECT coalesce(max(number),0)+1 AS number FROM tasks WHERE project_id=$1",
      [projectId],
    )
  ).rows;

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    flowId: flow.id,
    runnerId: runner,
    title: "Launch qualification",
    prompt: "Execute test",
    number: next.number,
  });
  const response = await launch(
    new Request("http://localhost/api/task-launch-intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        taskId,
        expectedTaskRevision: 0,
        expectedSettingsToken: await taskLaunchSettingsToken(db, taskId),
      }),
    }),
  );

  return { status: response.status, body: await response.json() };
}

it("admits only eligible siblings as frozen declarations realize, fail setup and recover trust", async () => {
  const db = database.db;
  const repo = await initRepo(join(root, "repo"));
  const capability = join(root, "bundle");
  const readyMarker = join(root, "setup-permitted");

  await mkdir(capability);
  await writeFile(
    join(capability, "setup.sh"),
    `#!/bin/sh\ntest -f '${readyMarker}'\n`,
    { mode: 0o755 },
  );
  const member = "packaged-dependency";
  const pkg = join(root, "package");

  await mkdir(pkg);
  await writeFile(
    join(pkg, "maister-package.yaml"),
    JSON.stringify({
      schemaVersion: 1,
      name: "import-consumer",
      flows: [{ id: member, path: "member" }],
    }),
  );
  await createFlow("package/member", {
    mcps: ["bundle"],
    nodes: [
      {
        id: "check",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  });
  const input = {
    schemaVersion: 2,
    project: { name: slug, default_runner: runner },
    flow_roles: [{ ref: "reviewer" }],
    flows: [
      {
        id: "needs-import",
        source: await createFlow("needs-import", {
          mcps: ["bundle"],
          nodes: [
            {
              id: "check",
              type: "cli",
              action: { command: "true" },
              transitions: { success: "done" },
            },
          ],
        }),
        version: "v1",
        runner,
      },
      {
        id: "ready-sibling",
        source: await createFlow("ready-sibling", {
          nodes: [
            {
              id: "review",
              type: "human",
              finish: { human: { role: "reviewer", decisions: ["approve"] } },
              transitions: { approve: "done" },
            },
          ],
        }),
        version: "v1",
        runner,
      },
      {
        id: "missing-runner",
        source: await createFlow("missing-runner", {
          nodes: [
            {
              id: "implement",
              type: "ai_coding",
              action: { prompt: "implement" },
              settings: { runner_type: "acp", runner: "absent" },
              transitions: { success: "done" },
            },
          ],
        }),
        version: "v1",
        runner: "absent",
      },
    ],
    packages: [{ id: "import-consumer", source: pkg, version: "local" }],
    capability_imports: [
      { id: "bundle", source: capability, version: "v1", trust: "explicit" },
    ],
  };
  const manifest = join(repo, "maister.yaml");

  await writeFile(manifest, JSON.stringify(input));
  const accepted = await register(
    new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ target: repo }),
    }),
  );

  expect(accepted.status).toBe(201);
  const { projectId } = await accepted.json();

  // No worker was present at acceptance. Change the manifest before its first tick.
  await writeFile(manifest, "schemaVersion: 99\n");
  const [decl] = await db
    .select()
    .from(projectDependencyDeclarations)
    .where(
      and(
        eq(projectDependencyDeclarations.projectId, projectId),
        eq(projectDependencyDeclarations.kind, "capability_import"),
      ),
    );
  const importAttempt = eq(projectDependencyAttempts.declarationId, decl.id);

  await db
    .update(projectDependencyAttempts)
    .set({ dueAt: new Date(Date.now() + 600_000) })
    .where(importAttempt);
  const signal = new AbortController().signal;

  const initiallyDue = [...input.flows, ...input.packages];

  for (const _item of initiallyDue)
    expect(await serviceDependency(db, signal)).toBe(true);
  expect(await serviceDependency(db, signal)).toBe(false);
  const states = await db
    .select()
    .from(projectDependencyAttempts)
    .where(eq(projectDependencyAttempts.projectId, projectId));

  expect(
    states
      .filter((item) => item.declarationId !== decl.id)
      .map((item) => [item.status, item.reason]),
  ).toEqual(initiallyDue.map(() => ["succeeded", null]));
  expect(
    await db
      .select()
      .from(projectFlowRunnerDefaults)
      .where(eq(projectFlowRunnerDefaults.projectId, projectId)),
  ).toHaveLength(2);
  expect(
    await db
      .select()
      .from(flowRunnerRemaps)
      .where(eq(flowRunnerRemaps.projectId, projectId)),
  ).toMatchObject([{ slotKey: "session:implement", status: "Pending" }]);
  const blocked = {
    status: 409,
    body: { details: { reason: "flow_capability_unavailable" } },
  };

  expect(await requestLaunch(projectId, "needs-import")).toMatchObject(blocked);
  expect(await requestLaunch(projectId, member)).toMatchObject(blocked);
  expect(await requestLaunch(projectId, "ready-sibling")).toMatchObject({
    status: 202,
  });
  expect(await requestLaunch(projectId, "missing-runner")).toMatchObject({
    status: 409,
  });

  await db
    .update(projectDependencyAttempts)
    .set({ dueAt: new Date() })
    .where(importAttempt);
  expect(await serviceDependency(db, signal)).toBe(true);
  expect(
    await db
      .select()
      .from(capabilityImports)
      .where(eq(capabilityImports.projectId, projectId)),
  ).toMatchObject([{ trustStatus: "untrusted", setupStatus: "pending" }]);
  expect(await requestLaunch(projectId, "needs-import")).toMatchObject(blocked);
  await expect(
    confirmCapabilityTrust({ projectId, capabilityRefId: "bundle", db }),
  ).rejects.toMatchObject({ code: "FLOW_INSTALL" });
  expect(await requestLaunch(projectId, "needs-import")).toMatchObject(blocked);
  await writeFile(readyMarker, "ready");
  await confirmCapabilityTrust({ projectId, capabilityRefId: "bundle", db });
  expect(await requestLaunch(projectId, "needs-import")).toMatchObject({
    status: 202,
  });
  expect(await requestLaunch(projectId, member)).toMatchObject({ status: 202 });
  expect(await requestLaunch(projectId, "missing-runner")).toMatchObject({
    status: 409,
  });
  const reservations = await db
    .select({ flowRef: flows.flowRefId })
    .from(taskLaunchIntents)
    .innerJoin(tasks, eq(tasks.id, taskLaunchIntents.taskId))
    .innerJoin(flows, eq(flows.id, tasks.flowId))
    .where(eq(tasks.projectId, projectId))
    .orderBy(flows.flowRefId);
  expect(reservations.map((row) => row.flowRef)).toEqual([
    "needs-import",
    member,
    "ready-sibling",
  ]);
}, 120_000);
