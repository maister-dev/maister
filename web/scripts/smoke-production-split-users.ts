import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { chromium, expect, type Browser } from "@playwright/test";

import { readLaunchResult } from "../e2e/_seed/launch-stream";
import { readTaskLaunchReceipt } from "../e2e/_seed/task-launch";
import { poll } from "../test-support/durable-workers-ledger";
import { WORKER_ADMIN } from "../test-support/durable-workers-seed";
import { startMainAndBrainPostgresTestDb } from "../test-support/pg-container";

const image = process.argv[2];

assert(
  image,
  "usage: smoke-production-split-users.ts IMAGE [--chrome] [--second-supervisor]",
);

const useChrome = process.argv.includes("--chrome");
const useSecondSupervisor = process.argv.includes("--second-supervisor");

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
let peerContainer: string | undefined;
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
    target = appContainer,
  ): Promise<string> =>
    docker(["exec", "--user", uid, ...options, target, ...args]);
  const adapterScript = `#!/bin/sh
while [ -n "${"$"}MOCK_ACP_S53_START_GATE" ] && [ ! -f "${"$"}MOCK_ACP_S53_START_GATE" ]; do sleep 0.1; done
exec node /app/supervisor/test/fixtures/mock-acp-adapter-resumable.mjs "$@"
`;
  await inContainer("0", [
    "sh",
    "-ec",
    `
    useradd -u 1002 -g 1001 -d /s53/host/home -s /usr/sbin/nologin maister-s53-host
    install -d -m 0755 /s53
    install -d -o 1001 -g 1001 -m 0700 /s53/web
    install -d -o 1002 -g 1001 -m 0700 /s53/host /s53/host/home /s53/host/journal
    install -d -o 1001 -g 1001 -m 2770 /s53/shared /s53/shared/worktrees
    cat > /s53/fixture <<'EOF'
${adapterScript}EOF
    chmod 0755 /s53/fixture
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
  const startSupervisor = (
    adapterEnvironment: string[],
    {
      root,
      port,
      user,
      workspaceRoot,
      target,
    }: {
      root: string;
      port: number;
      user: string;
      workspaceRoot: string;
      target: string;
    },
  ): Promise<string> =>
    docker([
      "exec",
      "--detach",
      "--user",
      user,
      "--workdir",
      "/app/supervisor",
      "--env",
      "HOME=" + root + "/home",
      "--env",
      "MAISTER_RUNTIME_ROOT=" + root,
      "--env",
      "MAISTER_EXECUTION_HOST_STATE_DIR=" + root + "/state",
      "--env",
      "MAISTER_SUPERVISOR_PORT=" + port,
      "--env",
      "MAISTER_WORKSPACE_ROOTS=" + workspaceRoot,
      "--env",
      "MAISTER_ADAPTER_BINARY_CLAUDE=/s53/fixture",
      ...adapterEnvironment,
      "--env",
      "MOCK_ACP_STATE_DIR=" + root + "/journal",
      "--env",
      "MAISTER_HEARTBEAT_INTERVAL_MS=1000",
      target,
      "sh",
      "-ec",
      'umask 002; echo "$$" > "$MAISTER_RUNTIME_ROOT/pid"; exec node --import tsx src/main.ts >> "$MAISTER_RUNTIME_ROOT/boot.log" 2>&1',
    ]);

  type HostIdentity = { hostKey: string; bootId: string };
  const readHost = async (
    endpoint = "http://127.0.0.1:7777",
  ): Promise<HostIdentity | null> => {
    const observed = await inContainer("1001:1001", [
      "node",
      "--input-type=module",
      "-e",
      `try {
        const result = await fetch(process.argv[1] + "/health", { signal: AbortSignal.timeout(1000) });
        console.log(JSON.stringify(result.ok ? (await result.json()).host : null));
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
        console.log("null");
      }`,
      endpoint,
    ]);

    return JSON.parse(observed) as HostIdentity | null;
  };

  const primary = {
    root: "/s53/host",
    port: 7777,
    user: "1002:1001",
    workspaceRoot: "/s53/shared",
    target: appContainer,
  };
  if (useSecondSupervisor) {
    peerContainer = await docker([
      "create",
      "--network",
      network,
      "--network-alias",
      "s53-host-b",
      "--user",
      "0",
      "--entrypoint",
      "/bin/sleep",
      image,
      "infinity",
    ]);
    await docker(["start", peerContainer]);
  }
  const secondary = peerContainer
    ? {
        root: "/s53/host-b",
        port: 7778,
        user: "1003:1001",
        workspaceRoot: "/s53/host-b/workspaces",
        target: peerContainer,
      }
    : null;
  const peerEndpoint = "http://s53-host-b:7778";
  const gate = primary.root + "/release-adapter";
  await startSupervisor(
    [
      "--env",
      "MOCK_ACP_REQUEST_PERMISSION=1",
      "--env",
      "MOCK_ACP_S53_START_GATE=" + gate,
    ],
    primary,
  );
  const initialHost = await poll(
    readHost,
    30_000,
    "initial supervisor identity",
  );
  let secondHost: HostIdentity | null = null;
  if (secondary) {
    await inContainer(
      "0",
      [
        "sh",
        "-ec",
        `
      useradd -u 1003 -g 1001 -d /s53/host-b/home -s /usr/sbin/nologin maister-s53-host-b
      install -d -m 0755 /s53
      install -d -o 1003 -g 1001 -m 0700 /s53/host-b /s53/host-b/home /s53/host-b/journal /s53/host-b/workspaces
      cat > /s53/fixture <<'EOF'
${adapterScript}EOF
      chmod 0755 /s53/fixture
    `,
      ],
      [],
      secondary.target,
    );
    await startSupervisor([], secondary);
    secondHost = await poll(
      () => readHost(peerEndpoint),
      30_000,
      "second supervisor identity",
    );
    assert.notEqual(secondHost.hostKey, initialHost.hostKey);
    assert.notEqual(secondHost.bootId, initialHost.bootId);
    assert.equal(
      await inContainer(
        "0",
        ["sh", "-ec", 'ps -o uid= -p "$(cat /s53/host-b/pid)" | tr -d " "'],
        [],
        secondary.target,
      ),
      "1003",
    );
    await inContainer("1001:1001", [
      "sh",
      "-ec",
      "test ! -e /s53/host-b && test ! -r /s53/host-b/state/state.sqlite",
    ]);
    await inContainer(
      secondary.user,
      [
        "sh",
        "-ec",
        "test -r /s53/host-b/state/state.sqlite && test ! -e /s53/host",
      ],
      [],
      secondary.target,
    );
    const aNamespace = await inContainer(primary.user, [
      "readlink",
      "/proc/self/ns/net",
    ]);
    const bNamespace = await inContainer(
      secondary.user,
      ["readlink", "/proc/self/ns/net"],
      [],
      secondary.target,
    );
    assert.notEqual(aNamespace, bNamespace);
    note("two-supervisors-ready", {
      primary: initialHost,
      secondary: secondHost,
      supervisorUids: [1002, 1003],
      ports: [primary.port, secondary.port],
      separateNetworkNamespaces: true,
    });
  }

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
  browser = await chromium.launch(useChrome ? { channel: "chrome" } : {});
  const context = await browser.newContext({
    baseURL: origin,
    locale: "en-US",
  });
  note("browser-ready", {
    browser: useChrome ? "Chrome" : "Chromium",
    version: browser.version(),
  });
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
  const launchFromBoard = async (taskId: string): Promise<string> => {
    await page.goto("/projects/" + witness.slug);
    const board = page.getByRole("region", { name: "Task board", exact: true });
    await board
      .getByRole("article")
      .filter({ hasText: "Durable worker flow task" })
      .getByRole("button", { name: "Launch", exact: true })
      .click({ timeout: 30_000 });
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/task-launch-intents" &&
        response.request().method() === "POST",
    );
    await page
      .getByTestId("task-launch-dialog")
      .getByRole("button", { name: "Launch", exact: true })
      .click();
    const receipt = await readTaskLaunchReceipt(await accepted);
    assert.equal(receipt.taskId, taskId);

    return poll(
      async () => {
        const { rows } = await db.pool.query<{ id: string }>(
          `select r.id from task_launch_intents i join runs r
          on r.id=i.run_id and r.task_launch_intent_id=i.id and r.task_id=i.task_id
          where i.id=$1 and i.task_id=$2`,
          [receipt.intentId, taskId],
        );
        return rows[0]?.id ?? null;
      },
      60_000,
      "browser intent bound to its Run",
    );
  };
  const runStatus = page.getByRole("main").getByTestId("run-header-status");
  const allow = page
    .getByTestId("pending-input-card")
    .getByRole("button", { name: /^allow$/i });

  const runId = await launchFromBoard(witness.taskId);
  await page.goto("/runs/" + runId);
  await expect(runStatus).toBeVisible();
  await expect(runStatus).not.toContainText("NeedsInput");

  // Keep the adapter at its start gate until a browser connection has received
  // the stream's initial marker. The permission event must arrive live.
  const livePermission = page.evaluate(
    (id) =>
      new Promise<string>((resolve, reject) => {
        const stream = new EventSource(
          "/api/runs/" + id + "/stream?replay=live",
        );
        const timeout = window.setTimeout(() => {
          stream.close();
          reject(
            new Error("the live stream did not deliver a permission event"),
          );
        }, 30_000);
        stream.onmessage = (message) => {
          const event = JSON.parse(message.data) as {
            type: string;
            runSequence?: string;
          };
          if (event.type === "session.stream_ready")
            document.documentElement.dataset.s53Stream = "ready";
          if (event.type !== "session.permission_request") return;
          window.clearTimeout(timeout);
          stream.close();
          resolve(event.runSequence ?? "");
        };
      }),
    runId,
  );
  const [permissionSequence] = await Promise.all([
    livePermission,
    (async () => {
      await page.waitForFunction(
        () => document.documentElement.dataset.s53Stream === "ready",
      );
      await inContainer("1002:1001", ["touch", gate]);
    })(),
  ]);
  assert.match(permissionSequence, /^\d+$/);
  await expect(runStatus).toContainText(/NeedsInput$/, { timeout: 30_000 });
  await expect(allow).toBeVisible();
  note("board-launch-and-live-permission", { runId });

  if (secondHost && secondary) {
    const { rows: active } = await db.pool.query<{ host_key: string }>(
      `select h.host_key from execution_assignments a
       join execution_hosts h on h.id=a.execution_host_id
       where a.run_id=$1 and a.state='active'`,
      [runId],
    );
    assert.deepEqual(active, [{ host_key: initialHost.hostKey }]);
    const { rows: registered } = await db.pool.query<{ host_key: string }>(
      "select host_key from execution_hosts where retired_at is null",
    );
    assert.deepEqual(registered, [{ host_key: initialHost.hostKey }]);
    const receiptCount = ({
      root,
      user,
      target,
    }: {
      root: string;
      user: string;
      target: string;
    }) =>
      inContainer(
        user,
        [
          "node",
          "--disable-warning=ExperimentalWarning",
          "--input-type=module",
          "-e",
          `import {DatabaseSync} from "node:sqlite";
       const db = new DatabaseSync(process.argv[1] + "/state/state.sqlite", {readOnly:true});
       console.log(db.prepare("select count(*) AS n from command_receipts where run_id=?").get(process.argv[2]).n);`,
          root,
          runId,
        ],
        [],
        target,
      );
    const primaryReceipts = Number(await receiptCount(primary));
    assert(primaryReceipts > 0);
    assert.equal(await receiptCount(secondary), "0");
    assert.deepEqual(await readHost(peerEndpoint), secondHost);
    const admin = await context.newPage();
    try {
      await admin.goto("/admin/execution-host");
      await expect(
        admin.getByText(initialHost.hostKey, { exact: true }).first(),
      ).toBeVisible();
      await expect(
        admin.getByText(secondHost.hostKey, { exact: true }),
      ).toHaveCount(0);
      if (process.env.MAISTER_S53_SCREENSHOT) {
        await admin.screenshot({ path: process.env.MAISTER_S53_SCREENSHOT });
      }
    } finally {
      await admin.close();
    }
    note("board-placement-with-two-live-supervisors", {
      runId,
      assignedHost: initialHost.hostKey,
      primaryReceipts,
      secondaryReceipts: 0,
    });
    await docker(["network", "disconnect", network, secondary.target]);
    assert.equal(await readHost(peerEndpoint), null);
    assert.deepEqual(await readHost(), initialHost);
    await docker([
      "network",
      "connect",
      "--alias",
      "s53-host-b",
      network,
      secondary.target,
    ]);
    const reconnected = await poll(
      () => readHost(peerEndpoint),
      30_000,
      "second supervisor reconnect",
    );
    assert.deepEqual(reconnected, secondHost);
    note("independent-supervisor-network-partition", {
      retainedPeer: secondHost,
    });
  }
  await db.pool.query(
    "update runs set keepalive_until=clock_timestamp()-interval '1 second' where id=$1",
    [runId],
  );
  const sweep = await api("/api/cron/gc", {
    method: "POST",
    headers: { "X-Maister-Cron-Token": cronToken },
  });
  assert([200, 207].includes(sweep.status));
  await expect(runStatus).toContainText("NeedsInputIdle", { timeout: 60_000 });
  await restartWeb();
  await page.reload();
  await expect(runStatus).toContainText("NeedsInputIdle");
  const responded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(
        "/api/runs/" + runId + "/hitl/",
      ) &&
      new URL(response.url()).pathname.endsWith("/respond") &&
      response.request().method() === "POST",
  );
  await allow.click();
  assert.equal((await responded).status(), 202);
  await expect(runStatus).toContainText("Review", { timeout: 90_000 });
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
  note("checkpoint-web-restart-and-resume", {
    epochs: epochs.map((x) => x.epoch),
    status: await runStatus.textContent(),
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
  const cancelled = await launchFromBoard(secondTask);
  await page.goto("/runs/" + cancelled);
  await expect(runStatus).toContainText(/NeedsInput$/, { timeout: 60_000 });
  await page
    .getByTestId("workbench-lifecycle-actions")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  const stopped = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/runs/" + cancelled + "/stop" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "Stop run" })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  const stopReply = await stopped;
  assert.equal(stopReply.status(), 200);
  assert.deepEqual(await stopReply.json(), {
    ok: true,
    runId: cancelled,
    runStatus: "Review",
    supervisorStopped: true,
  });
  await expect(runStatus).toContainText("Review", { timeout: 30_000 });
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
  await startSupervisor(["--env", "MOCK_ACP_REQUEST_PERMISSION=0"], primary);
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
      const cleanup = [container, peerContainer].filter(
        (id): id is string => id !== undefined,
      );
      const results = await Promise.allSettled(
        cleanup.map(async (id) => {
          await docker(["stop", "--time", "2", id]);
          await docker(["rm", id]);
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
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
