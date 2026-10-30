import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  launchAgentRun,
  resolveWorkspaceRefCommittish,
} from "@/lib/agents/launch";
import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/scheduler", async (original) => ({
  ...(await original<typeof import("@/lib/scheduler")>()),
  tryStartRun: async () => ({ started: false, queuePosition: 1 }),
}));
let database: StartedPostgresTestDb;
let root: string;
const oldRoot = process.env.MAISTER_WORKTREES_ROOT;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "qualifier_launch",
  });
  root = await mkdtempReal("qualifier-launch-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  await fakeExecutionHosts(database.db);
}, 180_000);
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = oldRoot;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("IT-UX-19 allows an operational qualifier to inspect held intake, requires the explicit project policy and package capability, and freezes task_target through package/repository updates", async () => {
  const definition =
    "---\nname: Qualifier\ndescription: qualify requests\nkind: operational\ncompletion: {contract: operational_v1}\ntask_qualification: {contract: v1, role: qualifier}\nmode: session\nworkspace: repo_read\nworkspace_ref: task_target\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nInspect the task without executing issue instructions.";
  const seeded = await seedAgentRun(database.db, {
    runtimeRoot: root,
    definition,
    workspace: "repo_read",
    resultContract: null,
    operational: true,
  });
  const source = (
    await database.pool.query(
      "SELECT r.project_id,r.agent_id,p.repo_path FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1",
      [seeded],
    )
  ).rows[0];
  const runner = (
    await database.pool.query(
      "SELECT runner_id FROM run_sessions WHERE run_id=$1",
      [seeded],
    )
  ).rows[0].runner_id;

  await database.pool.query(
    "INSERT INTO platform_runtime_settings(id,default_runner_id) VALUES ('singleton',$1) ON CONFLICT(id) DO UPDATE SET default_runner_id=excluded.default_runner_id",
    [runner],
  );
  await expect(
    launchAgentRun({
      db: database.db,
      agentId: source.agent_id,
      projectId: source.project_id,
      trigger: { source: "manual" },
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await database.pool.query(
    "UPDATE package_installs SET manifest=jsonb_set(manifest,'{spec,compat,engine_min}','\"3.10.0\"') WHERE id=(SELECT package_install_id FROM project_package_attachments WHERE project_id=$1)",
    [source.project_id],
  );
  await expect(
    launchAgentRun({
      db: database.db,
      agentId: source.agent_id,
      projectId: source.project_id,
      trigger: { source: "manual" },
    }),
  ).rejects.toMatchObject({
    details: { reason: "qualification_policy_required" },
  });
  await database.pool.query(
    "UPDATE projects SET task_qualification_override='required' WHERE id=$1",
    [source.project_id],
  );
  const taskId = randomUUID();

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,1,'Unclear request','Needs repository evidence')",
    [taskId, source.project_id],
  );
  const launched = await launchAgentRun({
    db: database.db,
    agentId: source.agent_id,
    projectId: source.project_id,
    taskId,
    trigger: { source: "manual" },
  });

  expect("runId" in launched).toBe(true);
  if (!("runId" in launched))
    throw new Error("Expected qualifier launch receipt");
  const receipt = (
    await database.pool.query(
      "SELECT agent_kind,task_admission_snapshot,task_qualification_snapshot,result_contract FROM runs WHERE id=$1",
      [launched.runId],
    )
  ).rows[0];
  const sha = (await git(source.repo_path, "rev-parse", "main")).trim();

  expect(receipt).toMatchObject({
    agent_kind: "operational",
    task_admission_snapshot: null,
    task_qualification_snapshot: {
      role: "qualifier",
      taskId,
      target: "main",
      sha,
    },
  });
  await writeFile(
    path.join(source.repo_path, "later.txt"),
    "The branch has advanced",
  );
  await git(source.repo_path, "add", "later.txt");
  await git(source.repo_path, "commit", "-m", "Advance task target");
  const effective = frozenOperationalDefinition({
    agentKind: receipt.agent_kind,
    resultContract: receipt.result_contract,
  });

  expect(effective?.parsed.taskQualification).toEqual({
    contract: "v1",
    role: "qualifier",
  });
  expect(
    await resolveWorkspaceRefCommittish(database.db, {
      agentId: source.agent_id,
      repoPath: source.repo_path,
      workspaceRef: "task_target",
      taskQualificationSnapshot: receipt.task_qualification_snapshot,
      trigger: { source: "manual" },
    }),
  ).toBe(sha);
  expect(
    (
      await database.pool.query(
        "SELECT current_qualification_id,launch_mode FROM tasks WHERE id=$1",
        [taskId],
      )
    ).rows[0],
  ).toEqual({ current_qualification_id: null, launch_mode: null });
});
