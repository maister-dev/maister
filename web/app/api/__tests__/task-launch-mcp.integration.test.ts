import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildCompiledMcp,
  connectCompiledMcp,
} from "../../../../mcp/test-support/compiled-client";

import { projects, taskLaunchIntents, tasks, runs } from "@/lib/db/schema";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { issueToken } from "@/lib/tokens/issue";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  seedTaskLaunchFixture,
  bindPendingTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let api: Server;
let mcp: Awaited<ReturnType<typeof connectCompiledMcp>>;
let sequence = 0;
let create: typeof import("@/app/api/v1/ext/task-launch-intents/route").POST;
let legacy: typeof import("@/app/api/v1/ext/runs/route").POST;
let options: typeof import("@/app/api/v1/ext/task-launch-intents/options/route").GET;
let read: typeof import("@/app/api/v1/ext/task-launch-intents/[intentId]/route").GET;
let cancel: typeof import("@/app/api/v1/ext/task-launch-intents/[intentId]/cancel/route").POST;
let replace: typeof import("@/app/api/v1/ext/task-launch-intents/[intentId]/replace/route").POST;
const requests: Array<{ method: string; path: string }> = [];

// The real Next request lifecycle runs these callbacks in the browser lane.
// Direct handler tests exercise admission without starting autonomous workers.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

async function routeRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;

  requests.push({ method: request.method, path });
  if (path === "/api/v1/ext/runs" && request.method === "POST")
    return legacy(request, {});
  if (
    path === "/api/v1/ext/task-launch-intents/options" &&
    request.method === "GET"
  ) {
    return options(request);
  }
  if (path === "/api/v1/ext/task-launch-intents" && request.method === "POST") {
    return create(request);
  }
  const match =
    /^\/api\/v1\/ext\/task-launch-intents\/([^/]+)(?:\/(cancel|replace))?$/.exec(
      path,
    );

  if (!match) throw new Error("Unexpected MCP bridge route");
  const context = {
    params: Promise.resolve({ intentId: decodeURIComponent(match[1]) }),
  };

  if (match[2] === "cancel" && request.method === "POST")
    return cancel(request, context);
  if (match[2] === "replace" && request.method === "POST")
    return replace(request, context);
  if (!match[2] && request.method === "GET") return read(request, context);
  throw new Error("Unexpected MCP bridge method");
}

async function nativeRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  const headers = new Headers();

  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value))
      value.forEach((part) => headers.append(name, part));
    else if (value !== undefined) headers.set(name, value);
  }

  return new Request(`http://127.0.0.1${request.url}`, {
    method: request.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

beforeAll(async () => {
  await buildCompiledMcp();
  database = await startMainPostgresTestDb({ databaseName: "task_launch_mcp" });
  root = await mkdtempReal("task-launch-mcp-");
  fixture = await seedTaskLaunchFixture(database, root);
  create = (await import("@/app/api/v1/ext/task-launch-intents/route")).POST;
  legacy = (await import("@/app/api/v1/ext/runs/route")).POST;
  options = (await import("@/app/api/v1/ext/task-launch-intents/options/route"))
    .GET;
  read = (await import("@/app/api/v1/ext/task-launch-intents/[intentId]/route"))
    .GET;
  cancel = (
    await import("@/app/api/v1/ext/task-launch-intents/[intentId]/cancel/route")
  ).POST;
  replace = (
    await import("@/app/api/v1/ext/task-launch-intents/[intentId]/replace/route")
  ).POST;
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Compiled MCP launch",
      scopes: ["runs:launch", "runs:read"],
    },
    database.db,
  );

  api = createServer(async (request, response) => {
    try {
      const result = await routeRequest(await nativeRequest(request));

      response.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries()),
      );
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          code: "BRIDGE",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();

  if (address === null || typeof address === "string")
    throw new Error("Expected bridge TCP address");
  mcp = await connectCompiledMcp({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: token.secret,
  });
}, 180_000);

afterAll(async () => {
  try {
    await mcp?.close();
  } finally {
    try {
      if (api?.listening) {
        await new Promise<void>((resolve, reject) =>
          api.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      await database?.stop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
});

async function taskInput() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Compiled MCP admission",
    prompt: "Private MCP task source sentinel",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });

  return { taskId };
}

async function launchInput(
  taskId: string,
  selection: Readonly<{ relaunchOfRunId?: string }> = {},
) {
  const result = await call("task_launch_options", { taskId, ...selection });
  const preview = z
    .object({
      taskId: z.string(),
      taskRevision: z.number().int().nonnegative(),
      settingsToken: z.string().min(1),
    })
    .parse(result.body);

  expect(result.isError).toBe(false);

  return {
    ...selection,
    taskId: preview.taskId,
    expectedTaskRevision: preview.taskRevision,
    expectedSettingsToken: preview.settingsToken,
  };
}

async function qualify(taskId: string): Promise<void> {
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
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown }> {
  const result = z
    .object({
      isError: z.boolean().optional(),
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .min(1),
    })
    .parse(await mcp.client.callTool({ name, arguments: args }));
  const body: unknown = JSON.parse(result.content[0].text);

  return { isError: result.isError === true, body };
}

const receiptSchema = z
  .object({
    intentId: z.string(),
    state: z.string(),
    stateVersion: z.number().int().positive(),
    basis: z.literal("automatic"),
  })
  .passthrough();

it("LA13 compiled MCP reaches real automatic acceptance, replay, read, replacement and cancellation", async () => {
  const input = await taskInput();

  await qualify(input.taskId);
  const request = {
    ...(await launchInput(input.taskId)),
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
    autoPromote: true,
    brainContext: false,
    deliveryPolicy: {
      strategy: "pull_request",
      push: "on_success",
      trigger: "auto_on_ready",
      targetBranch: null,
    },
    executionPolicy: {
      preset: "supervised",
      overrides: {
        budget: { run: { maxTokens: 1000 } },
        onBudgetBreach: "terminate_restorable",
      },
    },
    operationKey: randomUUID(),
  };
  const accepted = await call("task_launch", request);
  const receipt = receiptSchema.parse(accepted.body);

  expect(accepted.isError).toBe(false);
  expect(receipt).toMatchObject({
    state: "queued",
    snapshot: { promotionMode: "pull_request", autoPromote: true },
  });
  const [stored] = await database.db
    .select({ settings: taskLaunchIntents.settingsSnapshot })
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(stored.settings).toMatchObject({
    deliveryPolicy: { ...request.deliveryPolicy, targetBranch: "main" },
    executionPolicy: request.executionPolicy,
    brainContext: false,
  });
  expect(await call("task_launch", request)).toEqual(accepted);
  expect(
    await call("task_launch_status", { intentId: receipt.intentId }),
  ).toEqual(accepted);
  expect(JSON.stringify(accepted.body)).not.toContain(
    "Private MCP task source sentinel",
  );
  const replaced = await call("task_launch_replace", {
    ...request,
    intentId: receipt.intentId,
    expectedStateVersion: receipt.stateVersion,
    autoPromote: false,
    operationKey: randomUUID(),
  });
  const successor = receiptSchema.parse(replaced.body);

  expect(replaced.isError).toBe(false);
  expect(successor).toMatchObject({
    state: "queued",
    supersedesIntentId: receipt.intentId,
    snapshot: { autoPromote: false },
  });
  expect(successor.intentId).not.toBe(receipt.intentId);
  const cancelled = await call("task_launch_cancel", {
    intentId: successor.intentId,
    expectedStateVersion: successor.stateVersion,
    operationKey: randomUUID(),
  });

  expect(cancelled.isError).toBe(false);
  expect(cancelled.body).toMatchObject({
    intentId: successor.intentId,
    basis: "automatic",
    state: "cancelled",
  });
  expect(
    await call("task_launch_status", { intentId: successor.intentId }),
  ).toEqual(cancelled);
  const compatibility = await call("run_launch", {
    ...(await launchInput(input.taskId)),
    operationKey: randomUUID(),
  });

  expect(compatibility.isError).toBe(false);
  expect(compatibility.body).toMatchObject({
    accepted: true,
    code: "launch_pending",
    state: "queued",
  });
  expect(
    (
      await database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(3);
  expect(
    (
      await database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM runs WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
  const previous = z.object({ intentId: z.string() }).parse(compatibility.body);
  const source = await bindPendingTaskLaunchFixture(
    database,
    previous.intentId,
  );

  await database.db
    .update(runs)
    .set({ status: "Failed" })
    .where(eq(runs.id, source.runId));
  const relaunch = await call("task_launch", {
    ...(await launchInput(input.taskId, { relaunchOfRunId: source.runId })),
    operationKey: randomUUID(),
  });
  const relaunched = receiptSchema.parse(relaunch.body);
  const [storedRelaunch] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, relaunched.intentId));

  expect(relaunch.isError).toBe(false);
  expect(storedRelaunch.sourceRunId).toBe(source.runId);
  expect(storedRelaunch.basis.kind).toBe("automatic");
  expect(storedRelaunch.settingsSnapshot).toMatchObject({
    relaunchSource: { runId: source.runId },
  });
});

it("LA07 compiled MCP preserves the server qualification refusal and refuses forged human authority locally", async () => {
  const input = await taskInput();
  const request = {
    ...(await launchInput(input.taskId)),
    operationKey: randomUUID(),
  };
  const refused = await call("task_launch", request);

  expect(refused.isError).toBe(true);
  expect(refused.body).toMatchObject({
    code: "PRECONDITION",
    details: { reason: "qualification_required" },
  });
  const upgrade = await call("run_launch", {
    taskId: input.taskId,
    operationKey: randomUUID(),
  });

  expect(upgrade.isError).toBe(true);
  expect(upgrade.body).toMatchObject({
    code: "CONFIG",
    details: { reason: "launch_request_upgrade_required" },
  });
  const count = requests.length;
  const forged = await call("task_launch", {
    ...request,
    mode: "manual",
    actorUserId: fixture.userId,
  });

  expect(forged.isError).toBe(true);
  expect(forged.body).toMatchObject({
    code: "CONFIG",
    details: { reason: "task_launch_arguments_invalid" },
  });
  expect(
    (await call("run_launch", { ...request, mode: "manual" })).isError,
  ).toBe(true);
  expect(requests).toHaveLength(count);
  expect(
    (
      await database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA07 launch options require current launch scope and existence-hide foreign tasks", async () => {
  const input = await taskInput();
  const readToken = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Read-only options",
      scopes: ["runs:read"],
    },
    database.db,
  );
  const address = api.address();

  if (!address || typeof address === "string")
    throw new Error("Expected bridge TCP address");
  const reader = await connectCompiledMcp({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: readToken.secret,
  });

  try {
    const denied = await reader.client.callTool({
      name: "task_launch_options",
      arguments: input,
    });

    expect(denied.isError).toBe(true);
  } finally {
    await reader.close();
  }
  const projectId = randomUUID();
  const taskId = randomUUID();

  await database.db.insert(projects).values({
    id: projectId,
    slug: projectId,
    name: "Foreign",
    repoPath: `${root}/foreign`,
    taskKey: "FOREIGN",
  });
  await database.db.insert(tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Foreign task",
    prompt: "Foreign input",
  });
  const missing = await call("task_launch_options", { taskId: randomUUID() });
  const foreign = await call("task_launch_options", { taskId });

  expect(missing.isError).toBe(true);
  expect(foreign.isError).toBe(true);
  expect(foreign.body).toEqual(missing.body);
  expect(
    (
      await database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});
