import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { chromium, type Browser } from "@playwright/test";

import { readLaunchResult } from "../e2e/_seed/launch-stream";
import { poll } from "../test-support/durable-workers-ledger";
import { WORKER_ADMIN } from "../test-support/durable-workers-seed";
import { launchFlowThroughHttp } from "../test-support/launch-flow-through-http";
import { startMainAndBrainPostgresTestDb } from "../test-support/pg-container";

const image = process.argv[2];

assert(image, "usage: smoke-production-split-users.ts IMAGE");

type SeededTarget = {
  projectId: string;
  slug: string;
  taskId: string;
};

function fixtureOutput(stdout: string, marker: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(marker));

  assert(line, `fixture did not emit ${marker}`);
  return line.slice(marker.length);
}

const execute = promisify(execFile);
const docker = async (
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> =>
  (
    await execute("docker", args, {
      timeout: 55_000,
      maxBuffer: 2 * 1024 * 1024,
      env,
    })
  ).stdout.trim();
const network = "maister-s53-" + randomUUID().slice(0, 8);
const db = await startMainAndBrainPostgresTestDb({
  databaseName: "s53_split_uid",
});
let container: string | undefined;
let browser: Browser | undefined;
let networkCreated = false;
let stage = "provision";
const note = (name: string, fields: Record<string, unknown> = {}): void => {
  stage = name;
  console.log(
    JSON.stringify({ test: "s53-split-linux-users", phase: name, ...fields }),
  );
};
try {
  await docker(["network", "create", network]);
  networkCreated = true;
  await docker([
    "network",
    "connect",
    "--alias",
    "s53-db",
    network,
    db.container.getId(),
  ]);
  const url = new URL(db.databaseUrl);
  url.hostname = "s53-db";
  url.port = "5432";
  const appContainer = await docker([
    "create",
    "--network",
    network,
    "-p",
    "127.0.0.1::3000",
    "--user",
    "0",
    "--entrypoint",
    "/bin/sleep",
    image,
    "infinity",
  ]);
  container = appContainer;
  await docker(["start", appContainer]);
  const inContainer = (
    uid: string,
    args: string[],
    options: string[] = [],
  ): Promise<string> =>
    docker(["exec", "--user", uid, ...options, appContainer, ...args]);
  await inContainer("0", [
    "sh",
    "-ec",
    `
    useradd -u 1002 -g 1001 -d /s53/host/home -s /usr/sbin/nologin maister-s53-host
    install -d -m 0755 /s53
    install -d -o 1001 -g 1001 -m 0700 /s53/web
    install -d -o 1002 -g 1001 -m 0700 /s53/host /s53/host/home /s53/host/journal
    install -d -o 1001 -g 1001 -m 2770 /s53/shared /s53/shared/worktrees
    cat > /s53/host/fixture <<'EOF'
#!/bin/sh
exec node /app/supervisor/test/fixtures/mock-acp-adapter-resumable.mjs "$@"
EOF
    chown 1002:1001 /s53/host/fixture
    chmod 0700 /s53/host/fixture
  `,
  ]);
  const port = (await docker(["port", container, "3000/tcp"]))
    .split(":")
    .at(-1);
  const origin = "http://127.0.0.1:" + port;
  const fixtureEnvironment = {
    ...process.env,
    DB_URL: url.toString(),
  };
  const seed = `
    import {closeDb,getDb} from "./lib/db/client.ts";
    import {seedAdmin,seedPlatformRunner,seedProjectRepo,seedFlowTask} from "./test-support/durable-workers-seed.ts";
    const db = getDb();
    await seedAdmin(db);
    await seedPlatformRunner(db);
    const project = await seedProjectRepo(db,"/s53/shared");
    const task = await seedFlowTask(db,{projectId:project.projectId,installedPath:"/s53/shared",terminalDelayMs:0});
    console.log("S53_SEED:"+JSON.stringify({...project,...task}));
    await closeDb();
  `;
  const seedOut = await docker(
    [
      "exec",
      "--user",
      "1001:1001",
      "--env",
      "DB_URL",
      "--env",
      "HOME=/app",
      "--workdir",
      "/app/web",
      appContainer,
      "sh",
      "-ec",
      'umask 002; exec node --import tsx --import ./scripts/_register-shim.mjs --input-type=module -e "$1"',
      "sh",
      seed,
    ],
    fixtureEnvironment,
  );
  const witness = JSON.parse(
    fixtureOutput(seedOut, "S53_SEED:"),
  ) as SeededTarget;
  const cronToken = "s53-disposable-cron-token";
  const startWeb = () =>
    docker(
      [
        "exec",
        "--detach",
        "--user",
        "1001:1001",
        "--workdir",
        "/app/web",
        "--env",
        "DB_URL",
        "--env",
        "HOME=/app",
        "--env",
        "AUTH_SECRET=s53-test-only",
        "--env",
        "AUTH_URL=" + origin,
        "--env",
        "AUTH_TRUST_HOST=true",
        "--env",
        "MAISTER_RUNTIME_ROOT=/s53/web",
        "--env",
        "MAISTER_WORKTREES_ROOT=/s53/shared/worktrees",
        "--env",
        "MAISTER_SUPERVISOR_URL=http://127.0.0.1:7777",
        "--env",
        "MAISTER_API_BASE_URL=" + origin,
        "--env",
        "MAISTER_SCHEDULER_TIMER_ENABLED=false",
        "--env",
        "MAISTER_DEFAULT_PACKAGE_SOURCES=",
        "--env",
        "MAISTER_CRON_TOKEN=" + cronToken,
        appContainer,
        "sh",
        "-ec",
        'umask 002; echo "$$" > /s53/web/pid; exec node --import tsx server.ts >> /s53/web/boot.log 2>&1',
      ],
      fixtureEnvironment,
    );
  const startSupervisor = (adapterEnvironment: string[]): Promise<string> =>
    docker([
      "exec",
      "--detach",
      "--user",
      "1002:1001",
      "--workdir",
      "/app/supervisor",
      "--env",
      "HOME=/s53/host/home",
      "--env",
      "MAISTER_RUNTIME_ROOT=/s53/host",
      "--env",
      "MAISTER_EXECUTION_HOST_STATE_DIR=/s53/host/state",
      "--env",
      "MAISTER_WORKSPACE_ROOTS=/s53/shared",
      "--env",
      "MAISTER_ADAPTER_BINARY_CLAUDE=/s53/host/fixture",
      ...adapterEnvironment,
      "--env",
      "MOCK_ACP_STATE_DIR=/s53/host/journal",
      "--env",
      "MAISTER_HEARTBEAT_INTERVAL_MS=1000",
      appContainer,
      "sh",
      "-ec",
      'umask 002; echo "$$" > /s53/host/pid; exec node --import tsx src/main.ts >> /s53/host/boot.log 2>&1',
    ]);

  type HostIdentity = { hostKey: string; bootId: string };
  const readHost = async (): Promise<HostIdentity | null> => {
    const observed = await inContainer("1001:1001", [
      "node",
      "--input-type=module",
      "-e",
      `try {
        const result = await fetch("http://127.0.0.1:7777/health", { signal: AbortSignal.timeout(1000) });
        console.log(JSON.stringify(result.ok ? (await result.json()).host : null));
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
        console.log("null");
      }`,
    ]);

    return JSON.parse(observed) as HostIdentity | null;
  };

  await startSupervisor(["--env", "MOCK_ACP_REQUEST_PERMISSION=1"]);
  const initialHost = await poll(
    readHost,
    30_000,
    "initial supervisor identity",
  );
  const ready = () =>
    poll(
      async () => {
        try {
          const response = await fetch(origin + "/login", {
            signal: AbortSignal.timeout(1000),
          });
          await response.arrayBuffer();
          return response.status === 200 ? true : null;
        } catch {
          return null;
        }
      },
      45_000,
      "image login readiness",
      200,
    );
  const restartWeb = async (): Promise<void> => {
    await inContainer("1001:1001", [
      "sh",
      "-ec",
      'kill -KILL "$(cat /s53/web/pid)"',
    ]);
    await startWeb();
    await ready();
  };

  await startWeb();
  await ready();
  const uid = await inContainer("0", [
    "sh",
    "-ec",
    'ps -o uid= -p "$(cat /s53/web/pid)"; ps -o uid= -p "$(cat /s53/host/pid)"; node --version',
  ]);
  assert.deepEqual(
    uid
      .split("\n")
      .map((x) => x.trim())
      .slice(0, 2),
    ["1001", "1002"],
  );
  assert.match(
    await inContainer("1002:1001", [
      "sh",
      "-ec",
      "test -r /s53/host/state/state.sqlite && printf readable",
    ]),
    /readable/,
  );
  const denied = await inContainer("1001:1001", [
    "node",
    "--input-type=module",
    "-e",
    'import fs from "node:fs"; try { fs.readFileSync("/s53/host/state/state.sqlite"); throw new Error("read allowed") } catch (err) { if(err.code !== "EACCES") throw err; console.log(err.code) }',
  ]);
  assert.equal(denied, "EACCES");
  note("separate-users", {
    linuxUid: [1001, 1002],
    node: uid.split("\n").at(-1),
    sqlite: "EACCES",
  });
  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(WORKER_ADMIN.email);
  await page.locator('input[name="password"]').fill(WORKER_ADMIN.password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((current) => current.pathname !== "/login", {
    timeout: 30_000,
  });
  const api = async (
    route: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const cookie = (await context.cookies())
      .map((c) => c.name + "=" + c.value)
      .join("; ");
    return fetch(origin + route, {
      ...init,
      headers: { ...init.headers, cookie },
    });
  };
  await page.goto("/projects/" + witness.slug);
  const runId = await launchFlowThroughHttp({
    api,
    origin,
    taskId: witness.taskId,
  });
  const runRow = async () =>
    (
      await db.pool.query<{ status: string }>(
        "select status from runs where id=$1",
        [runId],
      )
    ).rows[0];
  const pending = await poll(
    async () => {
      const { rows } = await db.pool.query<{ id: string }>(
        "select h.id from hitl_requests h join runs r on r.id=h.run_id where h.run_id=$1 and r.status='NeedsInput' and h.responded_at is null",
        [runId],
      );
      return rows[0] ?? null;
    },
    60_000,
    "live permission request",
  );
  await page.goto("/runs/" + runId);
  await page
    .getByRole("main")
    .getByTestId("run-header-status")
    .waitFor({ timeout: 30_000 });
  const liveStream = await api("/api/runs/" + runId + "/stream", {
    signal: AbortSignal.timeout(15_000),
  });

  assert.equal(liveStream.status, 200);
  assert.match(
    liveStream.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  const streamReader = liveStream.body?.getReader();

  assert(streamReader);
  try {
    assert(
      (await streamReader.read()).value?.byteLength,
      "run stream returned no event bytes",
    );
  } finally {
    await streamReader.cancel();
  }
  note("board-launch-and-permission");
  await db.pool.query(
    "update runs set keepalive_until=clock_timestamp()-interval '1 second' where id=$1",
    [runId],
  );
  const sweep = await api("/api/cron/gc", {
    method: "POST",
    headers: { "X-Maister-Cron-Token": cronToken },
  });
  assert([200, 207].includes(sweep.status));
  await poll(
    async () => ((await runRow()).status === "NeedsInputIdle" ? true : null),
    60_000,
    "checkpointed permission",
  );
  await restartWeb();
  const respond = await page.request.post(
    "/api/runs/" + runId + "/hitl/" + pending.id + "/respond",
    { data: { optionId: "allow" } },
  );
  assert.equal(respond.status(), 202);
  await poll(
    async () =>
      ["Review", "Done"].includes((await runRow()).status) ? true : null,
    90_000,
    "resumed Flow completion",
  );
  const { rows: epochs } = await db.pool.query<{
    epoch: number;
    state: string;
    execution_workspace_id: string;
  }>(
    "select epoch,state,execution_workspace_id from execution_assignments where run_id=$1 order by epoch",
    [runId],
  );
  assert.deepEqual(
    epochs.map((x) => x.epoch),
    [1, 2],
  );
  assert.equal(
    epochs[0].execution_workspace_id,
    epochs[1].execution_workspace_id,
  );
  await page.reload();
  await page.getByRole("main").getByTestId("run-header-status").waitFor();
  note("checkpoint-web-restart-and-resume", {
    epochs: epochs.map((x) => x.epoch),
    status: (await runRow()).status,
  });
  const secondProject = await docker(
    [
      "exec",
      "--user",
      "1001:1001",
      "--env",
      "DB_URL",
      "--env",
      "HOME=/app",
      "--workdir",
      "/app/web",
      appContainer,
      "sh",
      "-ec",
      'umask 002; exec node --import tsx --import ./scripts/_register-shim.mjs --input-type=module -e "$1"',
      "sh",
      `
    import {closeDb,getDb} from "./lib/db/client.ts"; import {seedFlowTask} from "./test-support/durable-workers-seed.ts";
    const task=await seedFlowTask(getDb(),{projectId:${JSON.stringify(witness.projectId)},installedPath:"/s53/shared",terminalDelayMs:0}); console.log("S53_TASK:"+task.taskId); await closeDb();
    `,
    ],
    fixtureEnvironment,
  );
  const secondTask = fixtureOutput(secondProject, "S53_TASK:");
  const cancelled = await launchFlowThroughHttp({
    api,
    origin,
    taskId: secondTask,
  });
  await poll(
    async () =>
      (await db.pool.query("select status from runs where id=$1", [cancelled]))
        .rows[0]?.status === "NeedsInput"
        ? true
        : null,
    60_000,
    "second permission",
  );
  const stopped = await api("/api/runs/" + cancelled + "/stop", {
    method: "POST",
    headers: { Origin: origin },
  });
  assert.equal(stopped.status, 200);
  await poll(
    async () => {
      const { rows } = await db.pool.query<{ active: boolean }>(
        "select exists(select 1 from execution_assignments where run_id=$1 and state='active') as active",
        [cancelled],
      );

      return rows[0]?.active === false ? true : null;
    },
    20_000,
    "cancellation releases execution assignment",
  );
  note("cancelled-independent-flow");

  // Reopen the same host state after a real restart. The upload runs against
  // the ordinary completion fixture mode so its launch stream is bounded.
  await inContainer("1002:1001", [
    "sh",
    "-ec",
    'kill -TERM "$(cat /s53/host/pid)"',
  ]);
  await poll(
    async () => ((await readHost()) === null ? true : null),
    30_000,
    "supervisor shutdown",
  );
  await startSupervisor(["--env", "MOCK_ACP_REQUEST_PERMISSION=0"]);
  const restartedHost = await poll(
    readHost,
    30_000,
    "restarted supervisor identity",
  );

  assert.equal(restartedHost.hostKey, initialHost.hostKey);
  assert.notEqual(restartedHost.bootId, initialHost.bootId);
  note("supervisor-restart");

  const html =
    "<!doctype html><script>throw new Error('must download')</script>";
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      projectId: witness.projectId,
      baseBranch: "main",
      name: "s53 artifact",
      prompt: "Read attachment",
      reasoningEffort: "high",
      attachments: [],
    }),
  );
  form.append("files", new Blob([html], { type: "text/html" }), "active.html");
  const scratch = await api("/api/scratch-runs", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(scratch.status, 200);
  const launched = await readLaunchResult(scratch);
  const object = await poll(
    async () => {
      const { rows } = await db.pool.query<{
        id: string;
        logical_name: string;
      }>(
        "select id,logical_name from execution_runtime_objects where run_id=$1 and state='available' and mime_type='text/html'",
        [launched.runId],
      );
      return rows[0] ?? null;
    },
    60_000,
    "sealed active upload",
  );
  const content =
    "/api/runs/" +
    launched.runId +
    "/runtime-objects/" +
    object.id +
    "/content";
  await restartWeb();
  const response = await api(content);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment/,
  );
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    page.goto(content, { timeout: 20_000 }).catch((error) => {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Download is starting")
      )
        throw error;
    }),
  ]);
  assert.equal(download.suggestedFilename(), object.logical_name);
  note("browser-active-content-download", { status: "passed" });
} catch (error) {
  console.error("fixture stage:", stage, error);
  if (container) {
    const tail = await docker([
      "exec",
      "--user",
      "0",
      container,
      "sh",
      "-c",
      "tail -n 18 /s53/web/boot.log /s53/host/boot.log",
    ]).catch(() => "");
    console.error(tail);
  }
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (container) {
        await docker(["stop", "--time", "2", container]);
        await docker(["rm", container]);
      }
    } finally {
      try {
        await db.stop();
      } finally {
        if (networkCreated) await docker(["network", "rm", network]);
      }
    }
  }
}
