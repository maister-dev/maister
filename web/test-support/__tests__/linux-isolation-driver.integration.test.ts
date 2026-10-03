import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import {
  access,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants } from "node:os";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import {
  linuxOuterEnvironment,
  linuxRuntimePaths,
  IsolationPolicyError,
  prepareLinuxIsolationPolicy,
} from "@/test-support/linux-isolation";
import {
  assertInvocationGroupEmpty,
  createInvocation,
  fixtureProcessEnvironment,
  FIXTURE_WATCHDOG,
  InvocationOwnershipError,
  registerRoot,
  registerSpawnedProcess,
  releaseInvocation,
  signalInvocationGroup,
} from "@/test-support/process-invocation";
import {
  observeLinuxApplication,
  resolveIsolationDriver,
  IsolationUnavailableError,
  waitForLinuxApplication,
} from "@/test-support/process-isolation";
import { assertNoLinuxDockerTcpAuthority } from "@/test-support/linux-network-authority";

async function assertRealDockerTcpRefusal(): Promise<void> {
  const endpoint = new URL(
    process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
  );

  if (endpoint.protocol !== "unix:")
    throw new Error(
      "Linux refusal control requires the documented local Unix Docker daemon",
    );
  const connections = new Set<Socket>();
  const server = createServer((client) => {
    const daemon = createConnection(endpoint.pathname);

    connections.add(client);
    connections.add(daemon);
    client.once("close", () => {
      connections.delete(client);
      daemon.destroy();
    });
    daemon.once("close", () => {
      connections.delete(daemon);
      client.destroy();
    });
    client.once("error", () => daemon.destroy());
    daemon.once("error", () => client.destroy());
    client.pipe(daemon).pipe(client);
  });
  const failures: unknown[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error(
        "Docker authority control did not acquire its own listener",
      );
    const response = await fetch(`http://127.0.0.1:${address.port}/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    const version: { ApiVersion: string } = await response.json();

    expect(response.status).toBe(200);
    expect(typeof version.ApiVersion).toBe("string");
    await expect(assertNoLinuxDockerTcpAuthority()).rejects.toThrow(
      /unauthenticated Docker TCP authority/u,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    for (const socket of connections) socket.destroy();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "real Docker TCP refusal and cleanup failed",
    );
  await assertNoLinuxDockerTcpAuthority();
}

it("LI-boundary: exact mounts deny private reads and escape paths while descendants retain authorized access", async () => {
  const evidence = await mkdtemp(
    path.join(tmpdir(), "maister-linux-evidence-"),
  );
  const invocation = await createInvocation(evidence);
  const root = await mkdtemp(path.join(tmpdir(), "maister-linux-boundary-"));

  await registerRoot(invocation, root, "linux-boundary");
  const privateRoot = path.join(root, "private");
  const appRoot = path.join(root, "application");
  const writableRoot = path.join(root, "web-state");

  await Promise.all(
    [privateRoot, appRoot, writableRoot].map((directory) => mkdir(directory)),
  );
  const sentinel = path.join(privateRoot, "sentinel");
  const state = path.join(privateRoot, "state.sqlite");
  const publicFile = path.join(appRoot, "public.txt");

  await writeFile(sentinel, "private-fixture-sentinel");
  await writeFile(publicFile, "public-fixture");
  await symlink(sentinel, path.join(appRoot, "private-alias"));
  const escape = path.join(appRoot, "namespace-escape");

  execFileSync(
    "cc",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("../fixtures/namespace-escape.c", import.meta.url)),
      "-o",
      escape,
    ],
    { timeout: 10_000, maxBuffer: 16_384 },
  );
  const database = new DatabaseSync(state);

  database.exec(
    "CREATE TABLE receipts(id TEXT PRIMARY KEY); INSERT INTO receipts VALUES ('committed')",
  );
  const policy = await prepareLinuxIsolationPolicy({
    invocation,
    cwd: appRoot,
    readOnlyPaths: [
      appRoot,
      ...linuxRuntimePaths([process.execPath, escape]).filter(
        (file) => file !== escape,
      ),
    ],
    writableRoots: [writableRoot],
    deniedRoots: [privateRoot],
    protectedFiles: [{ path: sentinel }, { path: state }],
  });
  const script = `
    (async () => {
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const net = require('node:net');
    const [sentinel, state, publicFile, writableRoot, hostPid, escape] = process.argv.slice(1);
    const errno = (fn) => { try { fn(); return 'SUCCESS'; } catch(e) { return e.code; } };
    const bridgePid = Number(fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ')[1]);
    const inspector = () => new Promise((resolve, reject) => {
      const socket = net.createConnection({host:'127.0.0.1',port:9229});
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('inspector control timed out')); });
      socket.once('connect', () => { socket.destroy(); resolve('SUCCESS'); });
      socket.once('error', error => { socket.destroy(); resolve(error.code); });
    });
    const inspectorBefore = await inspector();
    process.kill(bridgePid, 'SIGUSR1');
    await new Promise(resolve => setTimeout(resolve, 200));
    const inspectorAfter = await inspector();
    const child = spawnSync(process.execPath, ['-e', "try{require('node:fs').readFileSync(process.argv[1]);process.exit(90)}catch(e){process.stdout.write(e.code)}", sentinel], {encoding:'utf8'});
    const status = fs.readFileSync('/proc/self/status','utf8');
    const escapeResult = spawnSync(escape, [], {encoding:'utf8'});
    const descriptorTargets = fs.readdirSync('/proc/self/fd').flatMap(fd => { try { return [fs.readlinkSync('/proc/self/fd/' + fd)]; } catch { return []; } });
    fs.writeFileSync(writableRoot + '/authorized', 'continued');
    process.stdout.write(JSON.stringify({
      sentinel: errno(() => fs.readFileSync(sentinel)),
      state: errno(() => fs.readFileSync(state)),
      readOnly: errno(() => fs.writeFileSync(publicFile,'changed')),
      publicBytes: fs.readFileSync(publicFile).length,
      childCode: child.status, childDenial: child.stdout,
      hostProc: errno(() => fs.readFileSync('/proc/' + hostPid + '/root' + sentinel)),
      symlink: errno(() => fs.readFileSync(require('node:path').dirname(publicFile) + '/private-alias')),
      traversal: errno(() => fs.readFileSync(writableRoot + '/../private/sentinel')),
      privateDescriptors: descriptorTargets.filter(target => target === sentinel || target === state),
      bridgeSocket: errno(() => fs.closeSync(fs.openSync('/proc/' + bridgePid + '/fd/1', 'w'))),
      bridgeAlive: errno(() => process.kill(bridgePid, 0)),
      inspectorBefore, inspectorAfter,
      escapeCode: escapeResult.status, escape: JSON.parse(escapeResult.stdout),
      capabilities: /^CapEff:\\s+0+$/m.test(status) && /^CapPrm:\\s+0+$/m.test(status) && /^CapAmb:\\s+0+$/m.test(status),
      noNewPrivileges: /^NoNewPrivs:\\s+1$/m.test(status),
      ambientSecret: process.env.S53A_AMBIENT_SECRET ?? null,
      ledger: process.env.MAISTER_TEST_PROCESS_LEDGER ?? null,
    }) + '\\n');
    setInterval(() => {}, 1000);
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const driver = resolveIsolationDriver();
  const wrapped = driver.wrap(
    [
      process.execPath,
      "-e",
      script,
      sentinel,
      state,
      publicFile,
      writableRoot,
      String(process.pid),
      escape,
    ],
    [privateRoot],
    policy,
  );
  const privateDescriptor = openSync(sentinel, "r");
  const child = spawn(wrapped.file, wrapped.args, {
    env: linuxOuterEnvironment(policy, {
      ...process.env,
      S53A_AMBIENT_SECRET: "must-not-export",
      ...(await fixtureProcessEnvironment(invocation)),
    }),
    cwd: appRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe", privateDescriptor],
  });

  closeSync(privateDescriptor);
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const observation = observeLinuxApplication(child);

  try {
    await registerSpawnedProcess(
      invocation,
      {
        role: "fixture",
        caseName: "LI-boundary",
        rootRole: "web",
        root: writableRoot,
        bootId: "boundary",
        logFile: null,
      },
      child,
    );
    await observation.ready;
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`boundary child did not report: ${stderr}`)),
        20_000,
      );

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8192);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 16_384) {
          clearTimeout(timer);
          reject(new Error("boundary report exceeded its bound"));
        }
        if (stdout.endsWith("\n")) {
          clearTimeout(timer);
          resolve(stdout);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`boundary child exited before report: ${stderr}`));
      });
    });

    const report: { escape: { userns: number } } = JSON.parse(output);

    // Bubblewrap's zero namespace quota gives ENOSPC; an enforcing LSM may
    // deny the same syscall earlier with EPERM. Neither permits a namespace.
    expect([constants.errno.ENOSPC, constants.errno.EPERM]).toContain(
      report.escape.userns,
    );
    expect(report).toEqual({
      sentinel: "ENOENT",
      state: "ENOENT",
      readOnly: "EROFS",
      publicBytes: 14,
      childCode: 0,
      childDenial: "ENOENT",
      hostProc: "ENOENT",
      symlink: "ENOENT",
      traversal: "ENOENT",
      privateDescriptors: [],
      bridgeSocket: "ENXIO",
      bridgeAlive: "SUCCESS",
      inspectorBefore: "ECONNREFUSED",
      inspectorAfter: "ECONNREFUSED",
      escapeCode: 0,
      escape: {
        userns: report.escape.userns,
        remount: constants.errno.EPERM,
        reentry: constants.errno.EPERM,
        bridgeDescriptor: constants.errno.EPERM,
        bridgePtrace: constants.errno.EPERM,
      },
      capabilities: true,
      noNewPrivileges: true,
      ambientSecret: null,
      ledger: null,
    });
    expect(await readFile(path.join(writableRoot, "authorized"), "utf8")).toBe(
      "continued",
    );
    expect(await readFile(publicFile, "utf8")).toBe("public-fixture");
    expect(database.prepare("SELECT id FROM receipts").get()).toEqual({
      id: "committed",
    });
  } finally {
    database.close();
    if (child.pid)
      await signalInvocationGroup(invocation, child.pid, "SIGKILL");
    await exited;
    if (child.pid) await assertInvocationGroupEmpty(invocation, child.pid);
    const cleanupErrors = await releaseInvocation(invocation, "LI-boundary");

    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "LI-boundary cleanup failed");
  }
}, 60_000);

it("LI-refusal: unavailable capabilities and invalid policies refuse launch and probes release on every failure", async () => {
  const evidence = await mkdtemp(
    path.join(tmpdir(), "maister-linux-refusal-evidence-"),
  );
  const invocation = await createInvocation(evidence);
  const root = await mkdtemp(path.join(tmpdir(), "maister-linux-refusal-"));

  await registerRoot(invocation, root, "linux-refusal");
  const application = path.join(root, "application");
  const privateRoot = path.join(root, "private");
  const writable = path.join(root, "web-state");

  await Promise.all(
    [application, privateRoot, writable].map((directory) => mkdir(directory)),
  );
  const sentinel = path.join(privateRoot, "sentinel");

  await writeFile(sentinel, "private-control");
  const capabilityDenial = path.join(
    application,
    "namespace-capability-denied",
  );

  execFileSync(
    "cc",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(
        new URL("../fixtures/namespace-capability-denied.c", import.meta.url),
      ),
      "-o",
      capabilityDenial,
    ],
    { timeout: 10_000, maxBuffer: 16_384 },
  );
  const input = {
    invocation,
    cwd: application,
    readOnlyPaths: [application, ...linuxRuntimePaths([process.execPath])],
    writableRoots: [writable],
    deniedRoots: [privateRoot],
    protectedFiles: [{ path: sentinel }],
  };
  const policy = await prepareLinuxIsolationPolicy(input);
  const info = statSync(privateRoot);
  const forged = {
    ...policy,
    mounts: [
      ...policy.mounts,
      {
        source: privateRoot,
        destination: privateRoot,
        device: info.dev,
        inode: info.ino,
        access: "read-only" as const,
        directory: true,
      },
    ],
  };

  try {
    await assertRealDockerTcpRefusal();
    expect(() =>
      resolveIsolationDriver().wrap(
        [process.execPath, "-e", "process.exit(90)"],
        [privateRoot],
        forged,
      ),
    ).toThrow(IsolationPolicyError);
    const invalidPolicies = [
      { ...input, readOnlyPaths: [...input.readOnlyPaths, privateRoot] },
      { ...input, readOnlyPaths: [...input.readOnlyPaths, application] },
      {
        ...input,
        readOnlyPaths: [
          ...input.readOnlyPaths,
          `${application}/../application`,
        ],
      },
      { ...input, cwd: privateRoot },
      { ...input, environmentKeys: ["NODE_OPTIONS"] },
    ];

    for (const invalid of invalidPolicies)
      await expect(prepareLinuxIsolationPolicy(invalid)).rejects.toThrow(
        IsolationPolicyError,
      );
    const alias = path.join(root, "private-alias");

    await symlink(privateRoot, alias);
    await expect(
      prepareLinuxIsolationPolicy({
        ...input,
        readOnlyPaths: [...input.readOnlyPaths, alias],
      }),
    ).rejects.toThrow(IsolationPolicyError);
    const exported = path.join(application, "exported-private-inode");

    await link(sentinel, exported);
    await expect(prepareLinuxIsolationPolicy(input)).rejects.toThrow(
      IsolationPolicyError,
    );
    await rm(exported);
    const marker = path.join(root, ".maister-test-invocation");

    await writeFile(marker, "foreign-marker");
    expect(() =>
      resolveIsolationDriver().wrap(
        [process.execPath, "-e", "process.exit(90)"],
        [privateRoot],
        policy,
      ),
    ).toThrow(InvocationOwnershipError);
    await writeFile(marker, invocation.id);
    const witness = path.join(writable, "application-exec-witness");
    const wrapped = resolveIsolationDriver().wrap(
      [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'unexpected-exec')",
        witness,
      ],
      [privateRoot],
      policy,
    );
    const child = spawn(capabilityDenial, [wrapped.file, ...wrapped.args], {
      cwd: application,
      env: linuxOuterEnvironment(policy, {
        ...process.env,
        ...(await fixtureProcessEnvironment(invocation)),
      }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    const observed = observeLinuxApplication(child);

    child.stderr!.resume();
    child.stdout!.resume();
    try {
      await registerSpawnedProcess(
        invocation,
        {
          role: "fixture",
          caseName: "LI-refusal",
          rootRole: "web",
          root: writable,
          bootId: "capability-denied",
          logFile: null,
        },
        child,
      );
      await expect(waitForLinuxApplication(observed, 20_000)).rejects.toThrow(
        IsolationUnavailableError,
      );
      await closed;
      await expect(access(witness)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        await signalInvocationGroup(invocation, child.pid, "SIGKILL");
      await closed;
      if (child.pid) await assertInvocationGroupEmpty(invocation, child.pid);
    }
    const controller = spawn(
      process.execPath,
      [
        "--import",
        FIXTURE_WATCHDOG,
        "--import",
        fileURLToPath(
          new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url),
        ),
        fileURLToPath(
          new URL("../fixtures/linux-probe-controls.mjs", import.meta.url),
        ),
        JSON.stringify(policy),
        sentinel,
      ],
      {
        cwd: application,
        env: {
          ...process.env,
          ...(await fixtureProcessEnvironment(invocation)),
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let diagnostics = "";
    const controllerClosed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      controller.once("close", (code, signal) => resolve({ code, signal })),
    );

    controller.stdout!.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_384);
    });
    controller.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(-8192);
    });
    let controllerTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      await registerSpawnedProcess(
        invocation,
        {
          role: "fixture",
          caseName: "LI-refusal",
          rootRole: "probe-controller",
          root: writable,
          bootId: "probe-failures",
          logFile: null,
        },
        controller,
      );
      const result = await Promise.race([
        controllerClosed,
        new Promise<never>((_, reject) => {
          controllerTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "probe failure controller exceeded its 45000ms deadline",
                ),
              ),
            45_000,
          );
        }),
      ]);

      expect(result, diagnostics).toEqual({ code: 0, signal: null });
      const report = output
        .trim()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as {
              event?: string;
              passed?: number;
              registered?: number;
              live?: number;
            };
          } catch {
            return { event: "diagnostic" };
          }
        })
        .find((entry) => entry.event === "linux-probe-failure-controls");

      expect(report).toEqual({
        event: "linux-probe-failure-controls",
        passed: 5,
        registered: 4,
        live: 0,
        node: process.versions.node,
      });
    } finally {
      if (controllerTimer) clearTimeout(controllerTimer);
      if (
        controller.pid &&
        controller.exitCode === null &&
        controller.signalCode === null
      )
        await signalInvocationGroup(invocation, controller.pid, "SIGKILL");
      await controllerClosed;
      if (controller.pid)
        await assertInvocationGroupEmpty(invocation, controller.pid);
    }
    await rename(application, `${application}-replaced`);
    await mkdir(application);
    expect(() =>
      resolveIsolationDriver().wrap(
        [process.execPath, "-e", "process.exit(90)"],
        [privateRoot],
        policy,
      ),
    ).toThrow(IsolationPolicyError);
  } finally {
    const failures = await releaseInvocation(invocation, "LI-refusal");

    if (failures.length)
      throw new AggregateError(failures, "LI-refusal cleanup failed");
  }
}, 60_000);
