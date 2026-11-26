import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { chromium, expect, type Browser } from "@playwright/test";
import { Pool } from "pg";

import { readLaunchResult } from "../e2e/_seed/launch-stream";
import { readTaskLaunchReceipt } from "../e2e/_seed/task-launch";
import { poll } from "../test-support/durable-workers-ledger";
import { WORKER_ADMIN } from "../test-support/durable-workers-seed";
import { startMainAndBrainPostgresTestDb } from "../test-support/pg-container";

const image = process.argv[2];

assert(
  image,
  "usage: smoke-production-split-users.ts IMAGE [--chrome] [--second-supervisor] [--addressed-build | --addressed-two-host]",
);

const useChrome = process.argv.includes("--chrome");
const addressedTwoHost = process.argv.includes("--addressed-two-host");
const useSecondSupervisor = addressedTwoHost || process.argv.includes("--second-supervisor");
const addressedBuild = addressedTwoHost || process.argv.includes("--addressed-build");
const addressedStopTaskTitle = "Stop an accepted private workload";
const addressedReworkTaskTitle = "Restore the selected workspace for rework";

type SeededTarget = {
  projectId: string;
  slug: string;
  taskId: string;
  repoPath: string;
  baseCommit?: string;
  stopTaskId?: string;
  reworkTaskId?: string;
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
// Each disposable container gets its own writable filesystem and enough room
// for the supervisor's SQLite reserve and the Next.js build.
const fixtureMount = "/s53:rw,exec,size=2147483648,mode=0755";
const temporaryMount = "/tmp:rw,exec,size=268435456,mode=1777";
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
    "--tmpfs",
    fixtureMount,
    "--tmpfs",
    temporaryMount,
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
    import {flowRevisions,platformAcpRunners,projects,tasks} from "./lib/db/schema.ts";
    import {testPlatformRunnerRow} from "./lib/__tests__/runner-fixtures.ts";
    import {seedAdmin,seedPlatformRunner,seedProjectRepo,seedFlowTask} from "./test-support/durable-workers-seed.ts";
    const db = getDb();
    await seedAdmin(db);
    const runnerId = await seedPlatformRunner(db);
    const project = await seedProjectRepo(db,${JSON.stringify(addressedBuild ? "/s53/host" : "/s53/shared")});
    let baseCommit;
    let manifest;
    let stopTaskId;
    let reworkTaskId;
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
if [ -f /s53/hold-peer-build ]; then
  printf '%s %s\\n' "$$" "$(ps -o pgid= -p "$$" | tr -d ' ')" > /s53/host/build-accepted
  while [ ! -f /s53/host/build-release ]; do sleep 0.1; done
fi
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
      const stopTask = await seedFlowTask(db,{projectId:project.projectId,installedPath:"/s53/shared",terminalDelayMs:0,manifest:{
        schemaVersion:1,name:"addressed-stop",nodes:[{
          id:"live",type:"cli",settings:{timeoutMs:180000},
          action:{command:${JSON.stringify(`set -eu
printf '%s %s\\n' "$$" "$(ps -o pgid= -p "$$" | tr -d ' ')" > stop-witness.txt
while :; do sleep 1; done`)}},
          transitions:{success:"done"}
        }]
      }});
      stopTaskId = stopTask.taskId;
      await db.update(tasks).set({title:${JSON.stringify(addressedStopTaskTitle)}}).where(eq(tasks.id,stopTaskId));
      const reworkTask = await seedFlowTask(db,{projectId:project.projectId,installedPath:"/s53/shared",terminalDelayMs:0,manifest:{
        schemaVersion:1,name:"addressed-rework",nodes:[
          {id:"work",type:"cli",action:{command:${JSON.stringify(`set -eu
test ! -e abandoned-attempt.txt
test ! -e changed-between-attempts.txt
printf '%s' "{{ review_comments ?? '' }}" > /dev/null
printf 'reviewed change\\n' > abandoned-attempt.txt`)}},transitions:{success:"review"}},
          {id:"review",type:"human",finish:{human:{role:"maintainer",decisions:["approve","rework"],commentsVar:"review_comments"}},
           transitions:{approve:"done",rework:"work"},
           rework:{allowedTargets:["work"],workspacePolicies:["fresh-attempt"],maxLoops:2,commentsVar:"review_comments"}}
        ]
      }});
      reworkTaskId = reworkTask.taskId;
      await db.update(tasks).set({title:${JSON.stringify(addressedReworkTaskTitle)}}).where(eq(tasks.id,reworkTaskId));
    }
    console.log("S53_SEED:"+JSON.stringify({...project,...task,baseCommit,stopTaskId,reworkTaskId}));
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
        ...(addressedTwoHost && secondHost ? [
          "--env",
          "MAISTER_ADDITIONAL_EXECUTION_HOSTS=" + JSON.stringify([{
            url: peerEndpoint, hostKey: secondHost.hostKey, displayName: "Build host B",
            projectIds: [witness.projectId], maxConcurrentRuns: 1,
          }]),
        ] : []),
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
      "--tmpfs",
      fixtureMount,
      "--tmpfs",
      temporaryMount,
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
        root: addressedTwoHost ? primary.root : "/s53/host-b",
        port: 7778,
        user: "1003:1001",
        workspaceRoot: addressedTwoHost ? primary.workspaceRoot : "/s53/host-b/workspaces",
        target: peerContainer,
      }
    : null;
  const peerEndpoint = "http://s53-host-b:7778";
  const gate = primary.root + "/release-adapter";
  const repositoryEnvironment = [
    "--env", "MAISTER_WORKSPACE_REPOSITORIES=" + JSON.stringify({ [witness.projectId]: witness.repoPath }),
    "--env", "MAISTER_ADAPTER_BINARY_CODEX=/s53/fixture",
  ];
  await startSupervisor(
    addressedBuild
      ? repositoryEnvironment
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
      useradd -u 1003 -g 1001 -d "$1/home" -s /usr/sbin/nologin maister-s53-host-b
      install -d -m 0755 /s53
      install -d -o 1003 -g 1001 -m 0700 "$1" "$1/home" "$1/journal" "$1/workspaces"
      cat > /s53/fixture <<'EOF'
${adapterScript}EOF
      chmod 0755 /s53/fixture
    `,
        "sh", secondary.root,
      ],
      [],
      secondary.target,
    );
    if (addressedTwoHost) {
      const bundle = await inContainer(primary.user, ["sh", "-ec", `
        git -C "$1" bundle create /s53/host/source.bundle --all
        base64 -w0 /s53/host/source.bundle
      `, "sh", witness.repoPath]);
      await inContainer("0", ["sh", "-ec", `
        printf '%s' "$1" | base64 -d > /s53/source.bundle
        chmod 0644 /s53/source.bundle
        touch /s53/hold-peer-build
      `, "sh", bundle], [], secondary.target);
      await inContainer(secondary.user, ["git", "clone", "--quiet", "/s53/source.bundle", witness.repoPath], [], secondary.target);
      await inContainer(secondary.user, ["git", "-C", witness.repoPath, "remote", "remove", "origin"], [], secondary.target);
    }
    await startSupervisor(addressedTwoHost ? repositoryEnvironment : [], secondary);
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
        ["sh", "-ec", 'ps -o uid= -p "$(cat "$1/pid")" | tr -d " "', "sh", secondary.root],
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
        'test -r "$1/state/state.sqlite" && test ! -e /s53/web',
        "sh", secondary.root,
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
    language: "en" | "ru" = "en",
  ): Promise<string> => {
    if (language === "ru")
      await context.addCookies([{ name: "NEXT_LOCALE", value: "ru", url: origin }]);
    await page.goto("/projects/" + witness.slug);
    const board = page.getByRole("region", { name: "Task board", exact: true });
    const launchLabel = language === "ru" ? "Запустить" : "Launch";
    const expectedPreview = selectedHost
      ? page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/runs/launch-options",
        )
      : undefined;
    await board
      .getByRole("article")
      .filter({ hasText: title })
      .getByRole("button", { name: launchLabel, exact: true })
      .click({ timeout: 30_000 });
    const dialog = page.getByTestId("task-launch-dialog");
    if (selectedHost) {
      assert(expectedPreview);
      const preview = await expectedPreview;
      assert.equal(preview.status(), 200, await preview.text());
      const options = (await preview.json()) as {
        executionHostOptions?: { defaultExecutionHostId: string; hosts: Array<{ id: string; displayName: string }> };
      };
      const hosts = options.executionHostOptions;
      assert(hosts && hosts.hosts.some(({ id }) => id === selectedHost.id));
      const defaultHost = hosts.hosts.find(({ id }) => id === hosts.defaultExecutionHostId);
      assert(defaultHost);
      const picker = dialog
        .locator('button[aria-haspopup="listbox"]')
        .filter({ hasText: defaultHost.displayName });
      await expect(picker).toBeVisible();
      await picker.focus();
      await page.keyboard.press("ArrowDown");
      const target = page.getByRole("option", { name: selectedHost.displayName, exact: true });
      await expect(target).toBeVisible();
      const ordered = await page.getByRole("option").allTextContents();
      const option = ordered.findIndex((name) => name.trim() === selectedHost.displayName);
      assert(option >= 0);
      await page.keyboard.press("Home");
      for (let index = 0; index < option; index++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(dialog.locator('button[aria-haspopup="listbox"]')
        .filter({ hasText: selectedHost.displayName })).toBeFocused();
    }
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/task-launch-intents" &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: launchLabel, exact: true }).click();
    const response = await accepted;
    if (selectedHost)
      assert.equal(
        response.request().postDataJSON().executionHostId,
        selectedHost.id,
      );
    const receipt = await readTaskLaunchReceipt(response);
    assert.equal(receipt.taskId, taskId);
    if (selectedHost) {
      const status = dialog.getByTestId("task-launch-intent-status");
      await expect(status.getByText(
        language === "ru" ? "Ожидает запуска" : "Waiting for dispatch",
        { exact: true },
      )).toBeVisible();
      await expect(status.getByText(selectedHost.displayName, { exact: true })).toBeVisible();
      await expect(status.getByText(
        `${selectedHost.displayName} (${language === "ru" ? "эпоха назначения" : "assignment epoch"} 1)`,
        { exact: true },
      )).toBeVisible({ timeout: 30_000 });
      note("addressed-board-live-placement", { taskId, language, hostId: selectedHost.id });
    }
    if (language === "ru")
      await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: origin }]);

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
    const registeredHost = (identity: HostIdentity) => poll(
      async () => {
        const { rows } = await db.pool.query<{
          id: string;
          displayName: string;
        }>(
          'select id, display_name as "displayName" from execution_hosts where host_key=$1 and retired_at is null',
          [identity.hostKey],
        );
        return rows[0] ?? null;
      },
      30_000,
      "registered private supervisor",
    );
    const selectedHost = await registeredHost(initialHost);
    note("addressed-board-launch", {
      ...initialHost,
      hostId: selectedHost.id,
      baseCommit: witness.baseCommit,
    });
    const ownedCheckoutForRun = async (
      runId: string,
      owner = primary,
    ): Promise<{
      handle: string;
      path: string;
      repository: string;
    } | null> => {
      const { rows } = await db.pool.query<{ handle: string | null }>(
        "select execution_workspace_id as handle from workspaces where run_id=$1",
        [runId],
      );
      const handle = rows[0]?.handle;
      if (!handle) return null;
      const checkout = JSON.parse(
        await inContainer(owner.user, [
          "node",
          "--input-type=module",
          "-e",
          `import { DatabaseSync } from "node:sqlite";
           const db = new DatabaseSync(process.argv[1], { readOnly: true });
           console.log(JSON.stringify(db.prepare("select real_path as path, repo_path as repository from workspaces where id=? and released_at is null").get(process.argv[2]) ?? null));`,
          owner.root + "/state/state.sqlite",
          handle,
        ], [], owner.target),
      ) as { path: string; repository: string } | null;

      return checkout ? { ...checkout, handle } : null;
    };
    const startBoardBuild = async (
      taskId: string,
      host: typeof selectedHost,
      title?: string,
      language: "en" | "ru" = "en",
    ): Promise<string> => {
      const runId = await launchFromBoard(taskId, host, title, language);
      await page.goto("/runs/" + runId);
      const allow = page
        .getByTestId("pending-input-card")
        .getByRole("button", { name: /^allow$/i });
      await expect(allow).toBeVisible({ timeout: 30_000 });
      await allow.click();
      await expect(allow).toBeHidden({ timeout: 30_000 });
      return runId;
    };
    const verifyRunBuild = async (
      runId: string,
      expectedCommit: string,
      host = selectedHost,
      identity = initialHost,
      owner = primary,
    ): Promise<{ runId: string; patch: string }> => {
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
      assert.equal(completed.execution_host_id, host.id);
      assert.equal(completed.base_commit, expectedCommit);
      assert.equal(completed.worktree_path, null);
      assert.equal(completed.parent_repo_path, null);
      if (new URL(page.url()).pathname !== `/runs/${runId}`) await page.goto(`/runs/${runId}`);
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
        [runId, host.id],
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
      const logfile = await inContainer(owner.user, [
        "tail",
        "-n",
        "250",
        owner.root + "/boot.log",
      ], [], owner.target);
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
      assert.equal(processWitness.hostKey, identity.hostKey);
      assert.equal(processWitness.exitCode, 0);
      assert.equal(processWitness.quiescence, "proved");
      assert(
        Number.isInteger(processWitness.processGroup) &&
          processWitness.processGroup > 0,
      );
      note("addressed-build-reached-review", {
        runId,
        baseCommit: expectedCommit,
        hostId: host.id,
        ...identity,
        processGroup: processWitness.processGroup,
        resultObjectId: rows[0].id,
        webRepositoryAccess: "EACCES",
      });

      return { runId, patch };
    };
    const verifyBuild = async (taskId: string, expectedCommit: string, title?: string, language?: "en" | "ru") =>
      verifyRunBuild(await startBoardBuild(taskId, selectedHost, title, language), expectedCommit);
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
    const second = await verifyBuild(secondTaskId, nextCommit, secondTitle, "ru");
    const retained = await api(`/api/runs/${first.runId}/diff?scope=run`);
    assert.equal(retained.status, 200);
    assert.equal((await retained.json()).diff, first.patch);
    note("addressed-upstream-advance", {
      firstRunId: first.runId,
      secondRunId: second.runId,
      nextCommit,
    });
    let restorePeerPilot: (() => Promise<void>) | undefined;
    if (addressedTwoHost) {
      assert(secondary && secondHost && witness.baseCommit);
      const peer = secondary;
      const peerIdentity = secondHost;
      const peerHost = await registeredHost(peerIdentity);
      const copyTask = async (title: string): Promise<string> => {
        const id = randomUUID();
        const created = await db.pool.query(
          `insert into tasks (id,project_id,number,title,prompt,flow_id)
           select $1,t.project_id,(select max(number)+1 from tasks where project_id=t.project_id),$2,t.prompt,t.flow_id
           from tasks t where t.id=$3`,
          [id, title, witness.taskId],
        );
        assert.equal(created.rowCount, 1);
        return id;
      };
      const peerTitle = "Private Next build pinned to B";
      const peerRunId = await startBoardBuild(await copyTask(peerTitle), peerHost, peerTitle);
      const privateCheckout = await poll(
        () => ownedCheckoutForRun(peerRunId, peer), 30_000, "B owns its private checkout",
      );
      const primaryCheckout = await ownedCheckoutForRun(first.runId, primary);
      assert(primaryCheckout);
      assert.equal(privateCheckout.repository, primaryCheckout.repository);
      assert.notEqual(privateCheckout.handle, primaryCheckout.handle);
      assert.equal(await ownedCheckoutForRun(peerRunId, primary), null);
      const witnessPath = peer.root + "/build-accepted";
      const [pid, pgid] = (await poll(async () => {
        const output = await inContainer(peer.user, ["sh", "-ec", 'if [ -s "$1" ]; then cat "$1"; fi', "sh", witnessPath], [], peer.target);
        return /^\d+ \d+$/u.test(output) ? output : null;
      }, 45_000, "B accepted the real Next build command")).split(" ");
      const cgroup = await inContainer(peer.user, ["cat", `/proc/${pid}/cgroup`], [], peer.target);
      const peerCommand = await poll(async () => {
        const { rows } = await db.pool.query<{ id: string; execution_host_id: string; assignment_epoch: number }>(
          "select id,execution_host_id,assignment_epoch from execution_commands where run_id=$1 and kind='workspace.run' and state='accepted'",
          [peerRunId],
        );
        return rows[0] ?? null;
      }, 20_000, "Web recorded the accepted B command");
      assert.equal(peerCommand.execution_host_id, peerHost.id);
      note("peer-build-accepted", { runId: peerRunId, commandId: peerCommand.id, ...peerIdentity, pid, pgid, cgroup, repository: privateCheckout.repository });
      await docker(["network", "disconnect", network, peer.target]);
      assert.equal(await readHost(peerEndpoint), null);
      const independentTitle = "Private Next build on A during B partition";
      const independent = await verifyBuild(await copyTask(independentTitle), nextCommit, independentTitle);
      assert.equal(await readHost(peerEndpoint), null);
      const countPeerTerminal = async () => (await db.pool.query<{ count: number }>(
        `select count(*)::int as count from execution_events where run_id=$1 and execution_host_id=$2
         and event_type='workspace.command.terminal' and payload->>'commandId'=$3`,
        [peerRunId, peerHost.id, peerCommand.id],
      )).rows[0].count;
      const receiptsFor = async (owner: typeof primary) => JSON.parse(await inContainer(owner.user, [
        "node", "--input-type=module", "-e",
        `import { DatabaseSync } from 'node:sqlite';
         const db=new DatabaseSync(process.argv[1],{readOnly:true});
         console.log(JSON.stringify(db.prepare("select command_id as id,phase,event_id as eventId from command_receipts where run_id=? and kind='workspace.run'").all(process.argv[2])));`,
        owner.root + "/state/state.sqlite", peerRunId,
      ], [], owner.target)) as Array<{ id: string; phase: string; eventId: string | null }>;
      assert.deepEqual(await receiptsFor(primary), []);
      await inContainer(peer.user, ["touch", peer.root + "/build-release"], [], peer.target);
      const terminal = await poll(async () => {
        const receipts = await receiptsFor(peer);
        assert.equal(receipts.length, 1);
        return receipts[0].phase === "completed" ? receipts[0] : null;
      }, 120_000, "B completed Next while disconnected");
      assert.equal(terminal.id, peerCommand.id);
      assert(terminal.eventId);
      assert.equal(await countPeerTerminal(), 0);
      const pinned = await db.pool.query<{ status: string; execution_host_id: string; epoch: number }>(
        `select r.status,a.execution_host_id,a.epoch from runs r join execution_assignments a on a.id=r.execution_assignment_id where r.id=$1`,
        [peerRunId],
      );
      assert.deepEqual(pinned.rows, [{ status: "Running", execution_host_id: peerHost.id, epoch: peerCommand.assignment_epoch }]);
      note("peer-partition-builds-settled", { peerRunId, independentRunId: independent.runId, terminalEventId: terminal.eventId, canonicalEventCount: 0 });
      await docker(["network", "connect", "--alias", "s53-host-b", network, peer.target]);
      assert.deepEqual(await poll(() => readHost(peerEndpoint), 30_000, "B reconnected"), peerIdentity);
      const peerBuild = await verifyRunBuild(peerRunId, witness.baseCommit, peerHost, peerIdentity, peer);
      assert.equal(await countPeerTerminal(), 1);
      assert.deepEqual(await receiptsFor(peer), [terminal]);
      assert.deepEqual(await receiptsFor(primary), []);
      note("peer-replay-applied-once", {
        runId: peerRunId, ...peerIdentity, commandId: terminal.id, terminalEventId: terminal.eventId, canonicalEventCount: 1,
      });
      restorePeerPilot = async () => {
        const dirtyFile = privateCheckout.path + "/restore-witness.txt";
        const dirtyBytes = "private B edit retained with its original owner";
        await inContainer(peer.user, ["sh", "-ec", 'printf "%s" "$2" > "$1"', "sh", dirtyFile, dirtyBytes], [], peer.target);
        const before = await api(`/api/runs/${peerRunId}/diff?scope=run`);
        assert.equal(before.status, 200, await before.clone().text());
        const { diff: dirtyPatch } = (await before.json()) as { diff: string };
        assert.notEqual(dirtyPatch, peerBuild.patch);
        assert(dirtyPatch.includes("+" + dirtyBytes));
        const web = { ...primary, root: "/s53/web", user: "1001:1001" };
        await page.goto("/login");
        const stopService = async (service: typeof primary): Promise<void> => {
          const pidFile = service.root + "/pid";
          await inContainer(service.user, ["sh", "-ec", 'kill -TERM "$(cat "$1")"', "sh", pidFile], [], service.target);
          await poll(async () => {
            const status = await inContainer(service.user, [
              "sh", "-ec", 'if ! kill -0 "$(cat "$1")" 2>/dev/null; then printf stopped; fi', "sh", pidFile,
            ], [], service.target);
            return status === "stopped" ? true : null;
          }, 30_000, `service at ${service.root} quiesced`);
        };
        await stopService(web);
        await Promise.all([stopService(primary), stopService(peer)]);
        // Move every fixture store aside and reopen the restored bytes at its original address.
        const restoreFiles = (owner: typeof primary, names: string[]): Promise<string> =>
          inContainer("0", ["sh", "-ec", `
            install -d -m 0700 /s53/pre-restore
            tar -czf /s53/checkpoint.tgz -C /s53 "$@"
            mv "$@" /s53/pre-restore/
            tar -xzf /s53/checkpoint.tgz -C /s53
          `, "sh", ...names], ["--workdir", "/s53"], owner.target);
        const restoredName = "s53_restored";
        const restorePostgres = async (): Promise<void> => {
          const dbTarget = db.container.getId();
          await docker(["exec", dbTarget, "sh", "-ec", `
            pg_dump -U "$POSTGRES_USER" -Fc "$1" > "$PGDATA/s53-checkpoint.dump"
            createdb -U "$POSTGRES_USER" "$2"
            pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$2" "$PGDATA/s53-checkpoint.dump"
          `, "sh", db.container.getDatabase(), restoredName]);
        };
        await Promise.all([restorePostgres(), restoreFiles(primary, ["web", "host", "shared"]), restoreFiles(peer, ["host"])]);
        const restoredDns = new URL(fixtureEnvironment.DB_URL);
        restoredDns.pathname = "/" + restoredName;
        fixtureEnvironment.DB_URL = restoredDns.href;
        const restoredLocal = new URL(db.databaseUrl);
        restoredLocal.pathname = "/" + restoredName;
        const restoredPool = new Pool({ connectionString: restoredLocal.href });
        try {
          const ledger = await restoredPool.query(
            `select r.status, w.execution_host_id, w.execution_workspace_id, c.state, c.assignment_epoch,
              (select count(*)::int from execution_events where id=$3) as event_count
             from runs r join workspaces w on w.run_id=r.id join execution_commands c on c.run_id=r.id
             where r.id=$1 and c.id=$2`,
            [peerRunId, peerCommand.id, terminal.eventId],
          );
          assert.deepEqual(ledger.rows, [{ status: "Review", execution_host_id: peerHost.id,
            execution_workspace_id: privateCheckout.handle, state: "succeeded", assignment_epoch: peerCommand.assignment_epoch,
            event_count: 1 }]);
        } finally {
          await restoredPool.end();
        }
        assert.equal(await inContainer(peer.user, ["cat", dirtyFile], [], peer.target), dirtyBytes);
        assert.deepEqual(await receiptsFor(peer), [terminal]);
        await Promise.all([startSupervisor(repositoryEnvironment, primary), startSupervisor(repositoryEnvironment, peer)]);
        const restoredA = await poll(readHost, 30_000, "restored A supervisor");
        const restoredB = await poll(() => readHost(peerEndpoint), 30_000, "restored B supervisor");
        assert.equal(restoredA.hostKey, initialHost.hostKey);
        assert.equal(restoredB.hostKey, peerIdentity.hostKey);
        assert.notEqual(restoredA.bootId, initialHost.bootId);
        assert.notEqual(restoredB.bootId, peerIdentity.bootId);
        await startWeb();
        await ready();
        const diff = await api(`/api/runs/${peerRunId}/diff?scope=run`);
        assert.equal(diff.status, 200, await diff.clone().text());
        assert.equal((await diff.json()).diff, dirtyPatch);
        await page.goto(`/runs/${peerRunId}#review-panel`);
        await expect(page.getByTestId("review-panel").getByText("acp-marker", { exact: true }).first()).toBeVisible();
        note("peer-coordinated-restore-verified", { peerRunId, restoredA, restoredB, terminalEventId: terminal.eventId, dirtyEditRetained: true });
      };
    }
    await page.goto(`/runs/${second.runId}#review-panel`);
    const reviewPanel = page.getByTestId("review-panel");
    await expect(
      reviewPanel.getByText("acp-marker", { exact: true }).first(),
    ).toBeVisible();
    const reviewedDiff = await api(
      `/api/runs/${second.runId}/diff?scope=uncommitted`,
    );
    assert.equal(reviewedDiff.status, 200, await reviewedDiff.clone().text());
    assert.equal(
      (await reviewedDiff.json()).diff,
      "",
      "the build left uncommitted files",
    );
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
    const ownedCheckout = await ownedCheckoutForRun(second.runId);
    assert(ownedCheckout, "the published Run did not retain its checkout");
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
    await page.goto(`/runs/${first.runId}#review-panel`);
    const gcPublication = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/runs/${first.runId}/promote` &&
        response.request().method() === "POST",
    );
    await page.getByTestId("review-panel").getByTestId("review-promote").click();
    const gcPublished = await gcPublication;
    assert.equal(gcPublished.status(), 200, await gcPublished.text());
    const overdue = await ownedCheckoutForRun(first.runId);
    assert(overdue, "the GC fixture has no retained checkout");
    const gcFilename = "retain-before-gc.txt";
    await inContainer(primary.user, [
      "sh", "-ec", 'printf "%s" "$2" > "$1"', "sh",
      overdue.path + "/" + gcFilename, archiveContent,
    ]);
    const scheduledGc = await db.pool.query(
      "update workspaces set scheduled_removal_at=clock_timestamp()-interval '1 second' where run_id=$1",
      [first.runId],
    );
    assert.equal(scheduledGc.rowCount, 1);
    const gc = await api("/api/cron/gc", {
      method: "POST",
      headers: { "X-Maister-Cron-Token": cronToken },
    });
    assert([200, 207].includes(gc.status), await gc.text());
    const swept = await poll(async () => {
      const { rows: [row] } = await db.pool.query<{
        archived_commit: string;
        removed_at: Date | null;
        removal_kind: string;
      }>("select archived_commit, removed_at, removal_kind from workspaces where run_id=$1", [first.runId]);
      return row?.removed_at ? row : null;
    }, 30_000, "selected supervisor retains bytes before retention GC");
    assert.equal(swept.removal_kind, "retention_gc");
    await inContainer(primary.user, ["test", "!", "-e", overdue.path]);
    assert.equal(await inContainer(primary.user, [
      "git", "-C", overdue.repository, "show", `${swept.archived_commit}:${gcFilename}`,
    ]), archiveContent);
    note("addressed-retention-gc", {
      runId: first.runId, hostId: selectedHost.id, archivedCommit: swept.archived_commit,
    });
    assert(witness.stopTaskId);
    const stoppedRunId = await launchFromBoard(
      witness.stopTaskId,
      selectedHost,
      addressedStopTaskTitle,
    );
    const activeWorkload = await poll(
      async () => {
        const checkout = await ownedCheckoutForRun(stoppedRunId);
        if (!checkout) return null;
        const observed = await inContainer(primary.user, [
          "sh",
          "-ec",
          'if test -s "$1"; then cat "$1"; fi',
          "sh",
          checkout.path + "/stop-witness.txt",
        ]);
        return observed ? { ...checkout, observed } : null;
      },
      30_000,
      "selected supervisor started the cancellable workload",
    );
    const [pid, processGroup] = activeWorkload.observed
      .split(/\s+/)
      .map(Number);
    assert(Number.isSafeInteger(pid) && pid > 1);
    assert(Number.isSafeInteger(processGroup) && processGroup > 1);
    await inContainer(primary.user, ["kill", "-0", String(pid)]);
    await page.goto(`/runs/${stoppedRunId}`);
    await page
      .getByRole("main")
      .getByTestId("workbench-lifecycle-actions")
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    const stopResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/runs/${stoppedRunId}/stop` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    const stopped = await stopResponse;
    assert.equal(stopped.status(), 200, await stopped.text());
    await expect(page.getByTestId("run-header-status")).toContainText(
      /review/i,
    );
    const {
      rows: [cancelled],
    } = await db.pool.query<{
      execution_host_id: string;
      quiescence: string;
      state: string;
    }>(
      `select execution_host_id, result->>'quiescence' as quiescence, state
       from execution_commands where run_id=$1 and kind='workspace.cancel'`,
      [stoppedRunId],
    );
    assert.deepEqual(cancelled, {
      execution_host_id: selectedHost.id,
      quiescence: "proved",
      state: "succeeded",
    });
    await inContainer(primary.user, [
      "sh",
      "-ec",
      "ps -eo pgid=,stat= | awk -v group=\"$1\" '$1==group && $2!~/^Z/ { alive=1 } END { exit alive }'",
      "sh",
      String(processGroup),
    ]);
    assert.equal(
      await inContainer(primary.user, [
        "cat",
        activeWorkload.path + "/stop-witness.txt",
      ]),
      activeWorkload.observed,
    );
    note("addressed-stop-retired-process-group", {
      runId: stoppedRunId,
      hostId: selectedHost.id,
      pid,
      processGroup,
    });
    assert(witness.reworkTaskId);
    const reworkRunId = await launchFromBoard(
      witness.reworkTaskId,
      selectedHost,
      addressedReworkTaskTitle,
    );
    await page.goto(`/runs/${reworkRunId}`);
    const rework = page.getByRole("button", {
      name: "Send back with comments",
      exact: true,
    });
    await expect(rework).toBeVisible({ timeout: 30_000 });
    const working = await ownedCheckoutForRun(reworkRunId);
    assert(working);
    assert.equal(
      await inContainer(primary.user, [
        "cat",
        working.path + "/abandoned-attempt.txt",
      ]),
      "reviewed change",
    );
    await inContainer(primary.user, [
      "sh",
      "-ec",
      'printf "%s" "discarded under explicit fresh-attempt policy" > "$1"',
      "sh",
      working.path + "/changed-between-attempts.txt",
    ]);
    await page
      .locator("#hitl-review-comments")
      .fill("Start from the accepted Git checkpoint.");
    await rework.click();
    const reworkResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        pathname.startsWith(`/api/runs/${reworkRunId}/hitl/`) &&
        pathname.endsWith("/respond") &&
        response.request().method() === "POST"
      );
    });
    await page.getByTestId("review-feedback-preview-confirm").click();
    const applied = await reworkResponse;
    assert.equal(applied.status(), 200, await applied.text());
    note("addressed-rework-accepted", {
      runId: reworkRunId,
      response: await applied.json(),
      decision: applied.request().postDataJSON().response,
    });
    const restored = await poll(
      async () => {
        const { rows } = await db.pool.query<{
          checkpoint_ref: string;
          command_id: string;
          execution_host_id: string;
        }>(
          `select first.checkpoint_ref, r.id as command_id, r.execution_host_id
         from node_attempts first join node_attempts second
           on second.run_id=first.run_id and second.node_id=first.node_id and second.attempt=2
         join execution_commands r on r.run_id=first.run_id and r.kind='workspace.restore'
           and r.payload->>'checkpointId'=split_part(first.checkpoint_ref, ':', 2)
         where first.run_id=$1 and first.node_id='work' and first.attempt=1
           and r.state='succeeded' and second.status='Succeeded'`,
          [reworkRunId],
        );
        return rows[0] ?? null;
      },
      20_000,
      "host command restored the checkpoint and the second attempt passed",
    ).catch(async (error: unknown) => {
      const { rows } = await db.pool.query(
        `select r.status,r.current_step_id,
          (select jsonb_agg(to_jsonb(n)) from (select node_id,status,attempt,checkpoint_ref
             from node_attempts where run_id=r.id) n) as attempts,
          (select jsonb_agg(to_jsonb(c)) from (select kind,state,last_error,payload->>'checkpointId' as checkpoint_id
             from execution_commands where run_id=r.id and kind like 'workspace.%') c) as commands
          from runs r where r.id=$1`,
        [reworkRunId],
      );
      note("addressed-rework-unsettled", { runId: reworkRunId, outcome: rows[0] });
      throw error;
    });
    assert.equal(restored.execution_host_id, selectedHost.id);
    assert.match(restored.checkpoint_ref, /^host-checkpoint:/);
    assert.equal(
      (await ownedCheckoutForRun(reworkRunId))?.handle,
      working.handle,
    );
    await inContainer(primary.user, [
      "test",
      "!",
      "-e",
      working.path + "/changed-between-attempts.txt",
    ]);
    note("addressed-rework-restored-checkpoint", {
      runId: reworkRunId,
      hostId: selectedHost.id,
      checkpointRef: restored.checkpoint_ref,
      restoreCommandId: restored.command_id,
    });
    await restorePeerPilot?.();
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
      'for log in /s53/web/boot.log /s53/host/boot.log; do if [ -f "$log" ]; then tail -n 18 "$log"; fi; done',
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
