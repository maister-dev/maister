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
  "usage: smoke-production-split-users.ts IMAGE [--chrome] [--second-supervisor] [--addressed-build]",
);

const useChrome = process.argv.includes("--chrome");
const useSecondSupervisor = process.argv.includes("--second-supervisor");
const addressedBuild = process.argv.includes("--addressed-build");

type SeededTarget = {
  projectId: string;
  slug: string;
  taskId: string;
  repoPath: string;
  baseCommit?: string;
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
  const adapterScript = addressedBuild
    ? `#!/bin/sh
exec node /app/supervisor/test/fixtures/mock-acp-lifecycle.mjs "$@"
`
    : `#!/bin/sh
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
    import {execFileSync} from "node:child_process";
    import {mkdir,writeFile} from "node:fs/promises";
    import {join} from "node:path";
    import {eq} from "drizzle-orm";
    import {closeDb,getDb} from "./lib/db/client.ts";
    import {flowRevisions,platformAcpRunners,projects} from "./lib/db/schema.ts";
    import {testPlatformRunnerRow} from "./lib/__tests__/runner-fixtures.ts";
    import {seedAdmin,seedPlatformRunner,seedProjectRepo,seedFlowTask} from "./test-support/durable-workers-seed.ts";
    const db = getDb();
    await seedAdmin(db);
    const runnerId = await seedPlatformRunner(db);
    const project = await seedProjectRepo(db,${JSON.stringify(addressedBuild ? "/s53/host" : "/s53/shared")});
    let baseCommit;
    let manifest;
    if (${addressedBuild}) {
      await db.update(platformAcpRunners).set(testPlatformRunnerRow(runnerId,"codex")).where(eq(platformAcpRunners.id,runnerId));
      await db.update(projects).set({deliveryPolicyDefault:{strategy:"publish_branch",push:"on_success",trigger:"manual",targetBranch:"main"}}).where(eq(projects.id,project.projectId));
      const git = (...args) => execFileSync("git", ["-C",project.repoPath,...args],{encoding:"utf8"}).trim();
      await mkdir(join(project.repoPath,"app"),{recursive:true});
      const files = {
        ".gitignore": "/node_modules\\n.next/\\nnext-env.d.ts\\n*.tsbuildinfo\\n",
        "package.json": JSON.stringify({name:"addressed-next-smoke",private:true}),
        "next.config.mjs": "export default {experimental:{cpus:1}};\\n",
        "tsconfig.json": JSON.stringify({compilerOptions:{target:"ES2022",module:"esnext",moduleResolution:"bundler",jsx:"react-jsx",strict:true,skipLibCheck:true,noEmit:true},include:["app/**/*.tsx"]}),
        "app/layout.tsx": "import type {ReactNode} from 'react'; export default function Layout({children}:{children:ReactNode}){return <html><body>{children}</body></html>}\\n",
        "app/page.tsx": "export default function Page(){return <main>Stage C hosted checkout</main>}\\n",
      };
      for (const [name,value] of Object.entries(files)) await writeFile(join(project.repoPath,name),value);
      git("add","--all");
      git("-c","user.name=Stage C","-c","user.email=stage-c@maister.local","commit","-m","Add private Next.js fixture");
      baseCommit=git("rev-parse","HEAD");
      manifest={schemaVersion:1,name:"addressed-next-build",nodes:[
        {id:"edit",type:"ai_coding",settings:{permissionMode:"ask"},action:{prompt:'fixture-output:{"bytes":0,"text":"addressed edit complete","permission":true,"writeWorkspaceMarker":true,"expectedCapabilityAgent":"codex"}'},transitions:{success:"build"}},
        {id:"build",type:"cli",settings:{timeoutMs:180000},action:{command:${JSON.stringify(`set -eu
test "$(cat acp-marker)" = 'written by addressed ACP'
ln -s /app/web/node_modules node_modules
node /app/web/node_modules/typescript/bin/tsc --noEmit
NEXT_TELEMETRY_DISABLED=1 node /app/web/node_modules/next/dist/bin/next build --webpack
test -s .next/BUILD_ID
git add -- acp-marker tsconfig.json
git -c user.name='Stage C' -c user.email=stage-c@maister.local -c commit.gpgsign=false commit -m 'Commit addressed ACP edit'
printf '%s\\n' '{"build":"passed","typecheck":"passed"}' > "$MAISTER_OUTPUT_FILE"`)}},
         output:{result:{schema:"./schemas/build.json",required:true}},transitions:{success:"done"}}
      ]};
    }
    const task = await seedFlowTask(db,{projectId:project.projectId,installedPath:"/s53/shared",terminalDelayMs:0,manifest});
    if (manifest) {
      const [revision]=await db.select({path:flowRevisions.installedPath}).from(flowRevisions).where(eq(flowRevisions.id,task.flowRevisionId));
      await mkdir(join(revision.path,"schemas"),{recursive:true});
      await writeFile(join(revision.path,"schemas","build.json"),JSON.stringify({schemaVersion:1,fields:[{name:"build",type:"string",required:true},{name:"typecheck",type:"string",required:true}]}));
    }
    console.log("S53_SEED:"+JSON.stringify({...project,...task,baseCommit}));
    await closeDb();
  `;
  const seedOut = await docker(
    [
      "exec",
      "--user",
      addressedBuild ? "1002:1001" : "1001:1001",
      "--env",
      "DB_URL",
      "--env",
      addressedBuild ? "HOME=/s53/host/home" : "HOME=/app",
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
        ...(addressedBuild
          ? [
              "--env",
              "MAISTER_SELECTED_EXECUTION_HOST_KEY=" + initialHost.hostKey,
            ]
          : []),
        "--env",
        "MAISTER_API_BASE_URL=" + origin,
        "--env",
        "MAISTER_SCHEDULER_TIMER_ENABLED=" +
          (addressedBuild ? "true" : "false"),
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
    workspaceRoot: addressedBuild ? "/s53/host" : "/s53/shared",
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
    addressedBuild
      ? [
          "--env",
          "MAISTER_WORKSPACE_REPOSITORIES=" +
            JSON.stringify({ [witness.projectId]: witness.repoPath }),
          "--env",
          "MAISTER_ADAPTER_BINARY_CODEX=/s53/fixture",
        ]
      : [
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
  const launchFromBoard = async (
    taskId: string,
    selectedHost?: { id: string; displayName: string },
    title = "Durable worker flow task",
  ): Promise<string> => {
    await page.goto("/projects/" + witness.slug);
    const board = page.getByRole("region", { name: "Task board", exact: true });
    const expectedPreview = selectedHost
      ? page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/runs/launch-options",
        )
      : undefined;
    await board
      .getByRole("article")
      .filter({ hasText: title })
      .getByRole("button", { name: "Launch", exact: true })
      .click({ timeout: 30_000 });
    const dialog = page.getByTestId("task-launch-dialog");
    if (selectedHost) {
      assert(expectedPreview);
      const preview = await expectedPreview;
      assert.equal(preview.status(), 200, await preview.text());
      const options = (await preview.json()) as {
        executionHostOptions?: { hosts: Array<{ id: string }> };
      };
      assert(
        options.executionHostOptions?.hosts.some(
          ({ id }) => id === selectedHost.id,
        ),
      );
      const picker = dialog
        .locator('button[aria-haspopup="listbox"]')
        .filter({ hasText: selectedHost.displayName });
      await expect(picker).toBeVisible();
      await picker.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("option", {
          name: selectedHost.displayName,
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(picker).toContainText(selectedHost.displayName);
    }
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/task-launch-intents" &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Launch", exact: true }).click();
    const response = await accepted;
    if (selectedHost)
      assert.equal(
        response.request().postDataJSON().executionHostId,
        selectedHost.id,
      );
    const receipt = await readTaskLaunchReceipt(response);
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
  if (addressedBuild) {
    await inContainer("1001:1001", [
      "node",
      "--input-type=module",
      "-e",
      `import {readdirSync} from "node:fs";
       for (const path of process.argv.slice(1)) {
         try { readdirSync(path); throw new Error("read allowed: " + path); }
         catch (error) { if (error.code !== "EACCES") throw error; }
       }`,
      witness.repoPath,
      primary.root,
    ]);
    const selectedHost = await poll(
      async () => {
        const { rows } = await db.pool.query<{
          id: string;
          displayName: string;
        }>(
          'select id, display_name as "displayName" from execution_hosts where host_key=$1 and retired_at is null',
          [initialHost.hostKey],
        );
        return rows[0] ?? null;
      },
      30_000,
      "registered private supervisor",
    );
    note("addressed-board-launch", {
      ...initialHost,
      hostId: selectedHost.id,
      baseCommit: witness.baseCommit,
    });
    const verifyBuild = async (
      taskId: string,
      expectedCommit: string,
      title?: string,
    ): Promise<{ runId: string; patch: string }> => {
      const runId = await launchFromBoard(taskId, selectedHost, title);
      await page.goto("/runs/" + runId);
      const allow = page
        .getByTestId("pending-input-card")
        .getByRole("button", { name: /^allow$/i });
      await expect(allow).toBeVisible({ timeout: 30_000 });
      await allow.click();
      await expect(allow).toBeHidden({ timeout: 30_000 });
      const completed = await poll(
        async () => {
          const { rows } = await db.pool.query<{
            status: string;
            base_commit: string;
            worktree_path: string | null;
            parent_repo_path: string | null;
            execution_host_id: string;
            refused_reason: string | null;
          }>(
            `select r.status,w.base_commit,w.worktree_path,w.parent_repo_path,w.execution_host_id,
            (select c.last_error->'details'->>'reason' from execution_commands c
              where c.run_id=r.id and c.kind in ('workspace.prepare','workspace.materialize')
                and c.state='failed' order by c.created_at desc limit 1) as refused_reason
            from runs r join workspaces w on w.run_id=r.id where r.id=$1`,
            [runId],
          );
          const row = rows[0];
          assert(
            !row?.refused_reason,
            `addressed preparation refused: ${row?.refused_reason}`,
          );
          assert(
            !row || !["Failed", "Crashed", "Abandoned"].includes(row.status),
            `addressed build ended in ${row?.status}`,
          );
          return row?.status === "Review" ? row : null;
        },
        180_000,
        "addressed ACP edit and build reached Review",
      );
      assert.equal(completed.execution_host_id, selectedHost.id);
      assert.equal(completed.base_commit, expectedCommit);
      assert.equal(completed.worktree_path, null);
      assert.equal(completed.parent_repo_path, null);
      await expect(page.getByTestId("run-header-status")).toContainText(
        /review/i,
      );
      const diff = await api(`/api/runs/${runId}/diff?scope=run`);
      assert.equal(diff.status, 200, await diff.clone().text());
      const { diff: patch } = (await diff.json()) as { diff: string };
      assert.match(patch, /\+written by addressed ACP/);
      await page.goto(`/runs/${runId}?wb=diff&scope=run`);
      await expect(
        page
          .getByTestId("diff-pane")
          .getByText("acp-marker", { exact: true })
          .first(),
      ).toBeVisible();
      const { rows } = await db.pool.query<{ id: string }>(
        `select id from execution_runtime_objects where run_id=$1 and execution_host_id=$2
       and logical_name='workload-result.json' and state='available'`,
        [runId, selectedHost.id],
      );
      assert.equal(rows.length, 1);
      const response = await api(
        `/api/runs/${runId}/runtime-objects/${rows[0].id}/content`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        build: "passed",
        typecheck: "passed",
      });
      const logfile = await inContainer(primary.user, [
        "tail",
        "-n",
        "250",
        primary.root + "/boot.log",
      ]);
      const workload = logfile
        .split("\n")
        .find(
          (line) =>
            line.includes(runId) && line.includes("workspace-workload-settled"),
        );
      assert(workload, "missing supervisor workload process evidence");
      const processWitness = JSON.parse(workload) as {
        hostKey: string;
        exitCode: number;
        quiescence: string;
        processGroup: number;
      };
      assert.equal(processWitness.hostKey, initialHost.hostKey);
      assert.equal(processWitness.exitCode, 0);
      assert.equal(processWitness.quiescence, "proved");
      assert(
        Number.isInteger(processWitness.processGroup) &&
          processWitness.processGroup > 0,
      );
      note("addressed-build-reached-review", {
        runId,
        baseCommit: expectedCommit,
        hostId: selectedHost.id,
        ...initialHost,
        processGroup: processWitness.processGroup,
        resultObjectId: rows[0].id,
        webRepositoryAccess: "EACCES",
      });

      return { runId, patch };
    };
    assert(witness.baseCommit);
    const first = await verifyBuild(witness.taskId, witness.baseCommit);
    const nextCommit = await inContainer(primary.user, [
      "sh",
      "-ec",
      `printf 'later upstream checkout\n' > "$1/upstream.txt"
       git -C "$1" add -- upstream.txt
       git -C "$1" -c user.name='Stage C' -c user.email=stage-c@maister.local commit -qm 'Advance private Next fixture'
       git -C "$1" rev-parse HEAD`,
      "sh",
      witness.repoPath,
    ]);
    assert.notEqual(nextCommit, witness.baseCommit);
    const secondTaskId = randomUUID();
    const secondTitle = "Private Next task after upstream update";
    const seeded = await db.pool.query(
      `insert into tasks (id,project_id,number,title,prompt,flow_id)
       select $1,project_id,number+1,$2,prompt,flow_id from tasks where id=$3`,
      [secondTaskId, secondTitle, witness.taskId],
    );
    assert.equal(seeded.rowCount, 1);
    const second = await verifyBuild(secondTaskId, nextCommit, secondTitle);
    const retained = await api(`/api/runs/${first.runId}/diff?scope=run`);
    assert.equal(retained.status, 200);
    assert.equal((await retained.json()).diff, first.patch);
    note("addressed-upstream-advance", {
      firstRunId: first.runId,
      secondRunId: second.runId,
      nextCommit,
    });
    await page.goto(`/runs/${second.runId}#review-panel`);
    const reviewPanel = page.getByTestId("review-panel");
    await expect(
      reviewPanel.getByText("acp-marker", { exact: true }).first(),
    ).toBeVisible();
    const reviewedDiff = await api(`/api/runs/${second.runId}/diff?scope=uncommitted`);
    assert.equal(reviewedDiff.status, 200, await reviewedDiff.clone().text());
    assert.equal((await reviewedDiff.json()).diff, "", "the build left uncommitted files");
    const publicationResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/runs/${second.runId}/promote` &&
        response.request().method() === "POST",
    );
    await reviewPanel.getByTestId("review-promote").click();
    const published = await publicationResponse;
    assert.equal(published.status(), 200, await published.text());
    const outcome = (await published.json()) as {
      commit: string;
      mode: string;
      publication: { remote: string; remoteBranch: string };
    };
    assert.equal(outcome.mode, "publish_branch");
    assert.equal(outcome.publication.remote, "origin");
    const reviewed = published.request().postDataJSON().reviewedSource as {
      head: string;
      fingerprint: string;
    };
    assert.equal(reviewed.head, outcome.commit);
    assert.match(reviewed.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      await inContainer(primary.user, [
        "git",
        "-C",
        witness.repoPath,
        "rev-parse",
        `refs/heads/${outcome.publication.remoteBranch}`,
      ]),
      outcome.commit,
    );
    await expect(page.getByTestId("run-header-status")).toContainText(/done/i);
    const {
      rows: [{ handle }],
    } = await db.pool.query<{ handle: string }>(
      "select execution_workspace_id as handle from workspaces where run_id=$1",
      [second.runId],
    );
    const ownedCheckout = JSON.parse(
      await inContainer(primary.user, [
        "node",
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(process.argv[1], { readOnly: true });
         console.log(JSON.stringify(db.prepare("select real_path as path, repo_path as repository from workspaces where id=? and released_at is null").get(process.argv[2])));`,
        primary.root + "/state/state.sqlite",
        handle,
      ]),
    ) as { path: string; repository: string };
    const archiveFile = "operator-note.txt";
    const archiveContent = "Retain work created after publication";
    await inContainer(primary.user, [
      "sh",
      "-ec",
      'printf "%s" "$2" > "$1"',
      "sh",
      ownedCheckout.path + "/" + archiveFile,
      archiveContent,
    ]);
    await page
      .getByRole("main")
      .getByTestId("workbench-lifecycle-actions")
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    const archiveResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/runs/${second.runId}/archive` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    const archived = await archiveResponse;
    assert.equal(archived.status(), 200, await archived.text());
    assert.equal((await archived.json()).workspaceRemoved, true);
    const {
      rows: [disposition],
    } = await db.pool.query<{
      archived_commit: string;
      removed_at: Date | null;
      removal_kind: string;
    }>(
      "select archived_commit, removed_at, removal_kind from workspaces where run_id=$1",
      [second.runId],
    );
    assert.equal(disposition.removal_kind, "archive");
    assert(disposition.removed_at);
    await inContainer(primary.user, ["test", "!", "-e", ownedCheckout.path]);
    assert.equal(
      await inContainer(primary.user, [
        "git",
        "-C",
        ownedCheckout.repository,
        "show",
        `${disposition.archived_commit}:${archiveFile}`,
      ]),
      archiveContent,
    );
    note("addressed-published-and-archived", {
      runId: second.runId,
      hostId: selectedHost.id,
      publishedCommit: outcome.commit,
      publishedBranch: outcome.publication.remoteBranch,
      archivedCommit: disposition.archived_commit,
    });
  } else {
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
    await expect(runStatus).toContainText("NeedsInputIdle", {
      timeout: 60_000,
    });
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
        new URL(response.url()).pathname ===
          "/api/runs/" + cancelled + "/stop" &&
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
    form.append(
      "files",
      new Blob([html], { type: "text/html" }),
      "active.html",
    );
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
  }
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
