import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { GET } from "@/app/api/task-launch-intents/options/route";
import { POST } from "@/app/api/task-launch-intents/route";
import {
  projects,
  tasks,
  taskLaunchIntents,
  runs,
  executionCommands,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { GET as EXTERNAL_OPTIONS } from "@/app/api/v1/ext/task-launch-intents/options/route";
import { POST as EXTERNAL_LAUNCH } from "@/app/api/v1/ext/task-launch-intents/route";
import { issueToken } from "@/lib/tokens/issue";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root = "";
let fixture: Awaited<ReturnType<typeof seedTaskLaunchFixture>>;
let userId = "";
let active = true;
let number = 0;
let agentInstallId = "";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!active) throw new MaisterError("UNAUTHENTICATED", "Session required");

    return { id: userId };
  },
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_agent_options",
  });
  root = await mkdtempReal("task-launch-agent-options-");
  fixture = await seedTaskLaunchFixture(database, root);
  userId = fixture.userId;
  const installed = path.join(root, "package");

  await mkdir(path.join(installed, "maister-agents"), { recursive: true });
  for (const [stem, flow] of [
    ["helper", ""],
    ["driver", `flow: ${fixture.flowId}\n`],
  ]) {
    await writeFile(
      path.join(installed, "maister-agents", `${stem}.md`),
      `---\nname: ${stem}\ndescription: task delivery\nkind: code_delivery\nworkspace: worktree\nmode: session\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n${flow}---\nExecute the exact task request.\n`,
    );
  }
  const installId = randomUUID();

  agentInstallId = installId;

  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,'local','launch-options','v1','fixture','{}','digest',$2,'Installed','trusted')",
    [installId, installed],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,'launch-options')",
    [randomUUID(), fixture.projectId, installId],
  );
  for (const stem of ["helper", "driver"]) {
    await database.pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled,flow_ref) VALUES($1,'launch-options','v1','authored',$2,'task delivery','worktree','session','[\"manual\"]','read_only',$3,true,$4)",
      [
        `launch-options:${stem}`,
        stem,
        path.join(installed, "maister-agents", `${stem}.md`),
        stem === "driver" ? fixture.flowId : null,
      ],
    );
    await database.pool.query(
      "INSERT INTO agent_project_links(id,agent_id,project_id) VALUES($1,$2,$3)",
      [randomUUID(), `launch-options:${stem}`, fixture.projectId],
    );
  }
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function task(): Promise<string> {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++number,
    title: "Exact agent options",
    prompt: "Private source request",
    qualificationMode: "required",
    flowId: null,
  });

  return taskId;
}
function preview(selection: Record<string, string>): Request {
  return new Request(
    `http://localhost/api/task-launch-intents/options?${new URLSearchParams(selection)}`,
  );
}
function launch(payload: object): Request {
  return new Request("http://localhost/api/task-launch-intents", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(payload),
  });
}

it("previews none without a repository and accepts only the subsequent explicit session decision", async () => {
  const taskId = await task();

  await database.db
    .update(projects)
    .set({ repoPath: path.join(root, "missing-repository") })
    .where(eq(projects.id, fixture.projectId));
  try {
    const selection = {
      taskId,
      agentId: "launch-options:helper",
      workspace: "none",
    };
    const response = await GET(preview(selection));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const options = await response.json();

    expect(options).toMatchObject({
      taskId,
      taskRevision: 0,
      settingsToken: expect.any(String),
      activeLaunch: null,
      target: {
        kind: "agent",
        agentId: selection.agentId,
        workspace: "none",
        flowId: null,
        sessions: [{ runnerId: fixture.runnerId }],
      },
    });
    expect(await database.db.select().from(taskLaunchIntents)).toEqual([]);
    expect(await database.db.select().from(runs)).toEqual([]);
    expect(await database.db.select().from(executionCommands)).toEqual([]);
    expect(JSON.stringify(options)).not.toContain("Private source request");
    const accepted = await POST(
      launch({
        ...selection,
        expectedTaskRevision: options.taskRevision,
        expectedSettingsToken: options.settingsToken,
      }),
    );

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      basis: "manual",
      snapshot: {
        kind: "agent",
        workspace: "none",
        flowId: null,
        baseCommit: null,
      },
    });
  } finally {
    await database.db
      .update(projects)
      .set({ repoPath: fixture.repo })
      .where(eq(projects.id, fixture.projectId));
  }
});

it("previews the declared Flow facade without inventing a standalone workspace or losing the selected agent", async () => {
  const taskId = await task();
  const selection = {
    taskId,
    agentId: "launch-options:driver",
    packageVersions: { [agentInstallId]: "keep" },
    deliveryPolicy: {
      strategy: "publish_branch",
      push: "on_success",
      trigger: "auto_on_ready",
      targetBranch: null,
    },
  };
  const response = await GET(
    preview({
      ...selection,
      packageVersions: JSON.stringify(selection.packageVersions),
      deliveryPolicy: JSON.stringify(selection.deliveryPolicy),
    }),
  );

  expect(response.status).toBe(200);
  const options = await response.json();

  expect(options.target).toMatchObject({
    kind: "flow",
    agentId: selection.agentId,
    flowId: fixture.flowId,
    workspace: "worktree",
    deliveryPolicy: { strategy: "publish_branch", trigger: "auto_on_ready" },
  });
  const unavailablePackage = await GET(
    preview({
      taskId,
      agentId: selection.agentId,
      packageVersions: JSON.stringify({ [randomUUID()]: "keep" }),
    }),
  );

  expect(unavailablePackage.status).toBe(409);
  expect(await unavailablePackage.json()).toMatchObject({
    details: { reason: "launch_package_changed" },
  });
  const accepted = await POST(
    launch({
      ...selection,
      expectedTaskRevision: options.taskRevision,
      expectedSettingsToken: options.settingsToken,
    }),
  );

  expect(accepted.status).toBe(202);
  const receipt = await accepted.json();

  expect(receipt).toMatchObject({
    basis: "manual",
    snapshot: { kind: "flow", flowId: fixture.flowId },
  });
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(intent.settingsSnapshot).toMatchObject({
    packageVersions: selection.packageVersions,
    deliveryPolicy: {
      strategy: "publish_branch",
      push: "on_success",
      trigger: "auto_on_ready",
    },
    serverExecution: { execution: { agentId: selection.agentId } },
  });
});

it("authenticates before query validation and hides inaccessible task options", async () => {
  active = false;
  try {
    expect(
      (
        await GET(
          new Request(
            "http://localhost/api/task-launch-intents/options?invalid=true",
          ),
        )
      ).status,
    ).toBe(401);
  } finally {
    active = true;
  }
  const taskId = await task();
  const viewerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'member','active',false)",
    [viewerId, `${viewerId}@test.local`],
  );
  userId = viewerId;
  try {
    const existing = await GET(
      preview({ taskId, agentId: "launch-options:helper", workspace: "none" }),
    );
    const missing = await GET(
      preview({
        taskId: randomUUID(),
        agentId: "launch-options:helper",
        workspace: "none",
      }),
    );

    expect(existing.status).toBe(404);
    expect(await existing.json()).toEqual(await missing.json());
  } finally {
    userId = fixture.userId;
  }
  expect(
    (
      await GET(
        preview({
          taskId,
          flowId: fixture.flowId,
          agentId: "launch-options:helper",
        }),
      )
    ).status,
  ).toBe(400);
});

it("uses the same facade target for bearer automation and cannot borrow the session's manual basis", async () => {
  const taskId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Agent facade automation",
      scopes: ["runs:launch"],
    },
    database.db,
  );
  const selection = { taskId, agentId: "launch-options:driver" };
  const authorization = { Authorization: `Bearer ${token.secret}` };
  const read = async () => {
    const response = await EXTERNAL_OPTIONS(
      new Request(
        `http://localhost/api/v1/ext/task-launch-intents/options?${new URLSearchParams(selection)}`,
        { headers: authorization },
      ),
    );

    expect(response.status).toBe(200);

    return response.json();
  };
  const accept = async (options: {
    taskRevision: number;
    settingsToken: string;
  }) =>
    EXTERNAL_LAUNCH(
      new Request("http://localhost/api/v1/ext/task-launch-intents", {
        method: "POST",
        headers: {
          ...authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          ...selection,
          expectedTaskRevision: options.taskRevision,
          expectedSettingsToken: options.settingsToken,
        }),
      }),
    );
  const unqualified = await accept(await read());

  expect(unqualified.status).toBe(409);
  expect(await unqualified.json()).toMatchObject({
    details: { reason: "qualification_required" },
  });
  const prepared = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await database.db.transaction(prepared.apply);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
  const accepted = await accept(await read());

  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({
    basis: "automatic",
    snapshot: { kind: "flow", flowId: fixture.flowId },
  });
});
