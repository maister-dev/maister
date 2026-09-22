import type { ChildProcess } from "node:child_process";

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  rm,
  writeFile,
  rename,
  symlink,
  mkdir,
  readlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  createInvocation,
  invocationEnvironment,
  readProcessSnapshot,
  registerProcess,
  sameProcess,
  fixtureProcessEnvironment,
  sweepInvocation,
  removeInvocationRoots,
  removeInvocationContainers,
  invocationRecords,
  readLogTail,
  type Invocation,
  registerRoot,
  processIdentity,
} from "@/test-support/process-invocation";
import {
  buildProductionWeb,
  productionWebBuild,
} from "@/test-support/real-web";

type StackReady = {
  workerPid: number;
  supervisorPid: number;
  webPid: number;
  invocation: Invocation;
  containerId: string;
};
const execFileAsync = promisify(execFile);

async function assertContainerRemoved(containerId: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(containerId))
    throw new Error("invalid owned container identity");
  try {
    await expect
      .poll(
        async () =>
          (
            await execFileAsync(
              "docker",
              [
                "container",
                "ls",
                "--all",
                "--filter",
                `id=${containerId}`,
                "--format",
                "{{.ID}}",
              ],
              { timeout: 10_000 },
            )
          ).stdout.trim(),
        { timeout: 30_000, interval: 500 },
      )
      .toBe("");
  } catch (error) {
    // Containment follows the failed Ryuk assertion and never turns it green.
    await execFileAsync("docker", ["container", "rm", "--force", containerId], {
      timeout: 10_000,
    });
    throw error;
  }
}

async function nestedStack(
  fixture: string,
  directory: string,
  reportFault?: "missing" | "invalid",
): Promise<{
  runner: ChildProcess;
  ready: StackReady;
  output: () => string;
  exited: Promise<number | null>;
}> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("cleanup control has no address");
  const readyMessage = new Promise<StackReady>((resolve, reject) => {
    server.once("error", reject);
    server.once("connection", (socket) => {
      let data = "";

      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 4096) {
          socket.destroy();
          reject(new Error("cleanup readiness exceeds its metadata budget"));
        }
      });
      socket.on("end", () => {
        try {
          resolve(JSON.parse(data) as StackReady);
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  const runner = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../fixtures/process-cleanup-runner.mjs", import.meta.url),
      ),
      `test-support/fixtures/process-cleanup-${fixture}.case.ts`,
      ...(reportFault ? [reportFault] : []),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MAISTER_TEST_EVIDENCE_DIR: directory,
        MAISTER_TEST_BUILT_WEB: JSON.stringify(await productionWebBuild()),
        MAISTER_TEST_CLEANUP_CONTROL_PORT: String(address.port),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const record = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-64 * 1024);
  };

  runner.stdout?.on("data", record);
  runner.stderr?.on("data", record);
  const exited = new Promise<number | null>((resolve, reject) => {
    runner.once("exit", resolve);
    runner.once("error", reject);
  });
  const timeout = AbortSignal.timeout(180_000);

  try {
    const ready = await Promise.race([
      readyMessage,
      exited.then((code): never => {
        throw new Error(
          `nested runner exited before readiness: ${code}\n${output}`,
        );
      }),
      new Promise<never>((_resolve, reject) =>
        timeout.addEventListener(
          "abort",
          () => reject(new Error(`nested readiness timed out\n${output}`)),
          { once: true },
        ),
      ),
    ]);

    return { runner, ready, output: () => output, exited };
  } catch (error) {
    runner.kill("SIGTERM");
    await exited;
    throw error;
  } finally {
    server.close();
  }
}

async function disposeNestedStack(
  stack: Awaited<ReturnType<typeof nestedStack>>,
  directory: string,
): Promise<void> {
  const failures: unknown[] = [];
  const cleanup = [
    () => writeFile(path.join(directory, "nested-runner.log"), stack.output()),
    () => stopIdleChild(stack.runner),
    () => sweepInvocation(stack.ready.invocation),
    () => assertContainerRemoved(stack.ready.containerId),
    () => removeInvocationContainers(stack.ready.invocation),
    () => removeInvocationRoots(stack.ready.invocation),
  ];

  for (const action of cleanup) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `nested cleanup failed; evidence: ${directory}`,
    );
  if (!process.env.MAISTER_TEST_EVIDENCE_DIR)
    await rm(directory, { recursive: true, force: true });
}

async function startIdleChild(
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const parent = ${process.pid}; if (process.ppid !== parent) process.exit(97); setInterval(() => { if (process.ppid !== parent) process.exit(97); }, 100).unref(); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`,
      ...args,
    ],
    {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (!child.stdout) throw new Error("fixture stdout unavailable");
  await once(child.stdout, "data");

  return child;
}

async function stopIdleChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");

  process.kill(-child.pid, "SIGKILL");
  await exited;
}

describe("S5.2 invocation process ownership", () => {
  it("O-build-lock: a proved dead owner is reclaimed and the verified artifact is reused", async () => {
    const directory = await mkdtemp(
      path.join(
        process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
        "s52-build-lock-",
      ),
    );
    const buildId = await buildProductionWeb(
      path.join(directory, "next-build.log"),
    );
    const invocation = await createInvocation(directory);
    const child = await startIdleChild({
      ...process.env,
      ...invocationEnvironment(invocation),
    });
    const lock = path.join(process.cwd(), ".next.build-lock");
    const ownerFile = path.join(invocation.directory, "dead-build-owner.json");

    try {
      await writeFile(
        ownerFile,
        JSON.stringify(await processIdentity(invocation, child.pid!)),
      );
      await symlink(ownerFile, lock);
      await stopIdleChild(child);
      expect(
        await buildProductionWeb(path.join(directory, "next-build.log")),
      ).toBe(buildId);
      await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stopIdleChild(child);
      const target = await readlink(lock).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;

          return null;
        },
      );

      if (target === ownerFile) await unlink(lock);
      if (!process.env.MAISTER_TEST_EVIDENCE_DIR)
        await rm(directory, { recursive: true, force: true });
    }
  }, 600_000);

  it.each([
    {
      name: "success",
      fixture: "clean",
      reportFault: undefined,
      code: 0,
      observation: '"outcome":"passed"',
    },
    {
      name: "assertion failure",
      fixture: "failure",
      reportFault: undefined,
      code: 1,
      observation: "intentional cleanup assertion failure",
    },
    {
      name: "missing reporter",
      fixture: "clean",
      reportFault: "missing" as const,
      code: 1,
      observation: "ENOENT",
    },
    {
      name: "invalid reporter",
      fixture: "clean",
      reportFault: "invalid" as const,
      code: 1,
      observation: "SyntaxError",
    },
  ])(
    "O-exit: $name retains the exact outcome and finishes cleanup",
    async ({ fixture, reportFault, code, observation }) => {
      const directory = await mkdtemp(
        path.join(
          process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
          "s52-exit-control-",
        ),
      );

      await buildProductionWeb(path.join(directory, "next-build.log"));
      const stack = await nestedStack(fixture, directory, reportFault);

      try {
        expect(await stack.exited).toBe(code);
        expect(stack.output()).toContain(observation);
        expect(stack.output()).toContain('"event":"sweep-complete"');
        expect(
          (await readProcessSnapshot(stack.ready.invocation)).filter(
            (entry) => entry.owned && !entry.zombie,
          ),
        ).toEqual([]);
        for (const record of await invocationRecords(stack.ready.invocation)) {
          if (record.kind === "root")
            await expect(access(record.root)).rejects.toMatchObject({
              code: "ENOENT",
            });
        }
      } catch (error) {
        throw new Error(`O-exit failed\n${stack.output()}`, { cause: error });
      } finally {
        await disposeNestedStack(stack, directory);
      }
    },
    600_000,
  );

  it("O-roots: live users, foreign markers and replaced roots refuse deletion; terminal cleanup preserves the sibling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "s52-root-control-"));
    const invocation = await createInvocation(directory);
    const sibling = await createInvocation(directory);
    const root = path.join(directory, "owned");
    const other = path.join(directory, "sibling");

    await mkdir(root);
    await mkdir(other);
    await registerRoot(invocation, root, "fixture");
    await registerRoot(sibling, other, "fixture");
    const child = await startIdleChild({
      ...process.env,
      ...invocationEnvironment(invocation),
    });

    try {
      await expect(
        registerRoot(invocation, invocation.directory, "fixture"),
      ).rejects.toThrow("exclude the evidence ledger");
      await expect(
        registerRoot(invocation, directory, "fixture"),
      ).rejects.toThrow("exclude the evidence ledger");
      await expect(removeInvocationRoots(invocation)).rejects.toThrow(
        "processes remain alive",
      );
      await stopIdleChild(child);
      await expect(registerRoot(invocation, other, "fixture")).rejects.toThrow(
        "different invocation",
      );
      await rename(root, `${root}.original`);
      await symlink(other, root, "dir");
      await expect(removeInvocationRoots(invocation)).rejects.toThrow(
        "root ownership changed",
      );
      await rm(root);
      await rename(`${root}.original`, root);
      await removeInvocationRoots(invocation);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(other)).resolves.toBeUndefined();
    } finally {
      await stopIdleChild(child);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("O2-runner: runner SIGKILL makes the live Vitest worker and real fixture groups terminate themselves", async () => {
    const directory = await mkdtemp(
      path.join(
        process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
        "s52-runner-death-",
      ),
    );

    await buildProductionWeb(path.join(directory, "next-build.log"));
    const stack = await nestedStack("held", directory);

    try {
      expect(
        (await readProcessSnapshot(stack.ready.invocation)).some(
          (entry) => entry.pid === stack.ready.workerPid && !entry.zombie,
        ),
      ).toBe(true);
      process.kill(stack.runner.pid!, "SIGKILL");
      await stack.exited;
      await expect
        .poll(
          async () =>
            (await readProcessSnapshot(stack.ready.invocation))
              .filter((entry) => entry.owned && !entry.zombie)
              .map((entry) => entry.pid),
          { timeout: 5_000, interval: 100 },
        )
        .toEqual([]);
      // The uncatchable runner death never executes a finalizer. Its surviving
      // outer owner removes inert roots only after self-termination is proved.
      await removeInvocationContainers(stack.ready.invocation);
      await removeInvocationRoots(stack.ready.invocation);
    } catch (error) {
      throw new Error(`O2-runner failed\n${stack.output()}`, { cause: error });
    } finally {
      await disposeNestedStack(stack, directory);
    }
  }, 600_000);

  it.each(["SIGINT", "SIGTERM"] as const)(
    "O-signal: runner %s preserves failure and completes real-stack cleanup",
    async (signal) => {
      const directory = await mkdtemp(
        path.join(
          process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
          "s52-runner-signal-",
        ),
      );

      await buildProductionWeb(path.join(directory, "next-build.log"));
      const stack = await nestedStack("held", directory);

      try {
        stack.runner.kill(signal);
        expect(await stack.exited).not.toBe(0);
        expect(stack.output()).toContain('"event":"lane-complete"');
        expect(stack.output()).toContain('"outcome":"failed"');
        expect(
          (await readProcessSnapshot(stack.ready.invocation)).filter(
            (entry) => entry.owned && !entry.zombie,
          ),
        ).toEqual([]);
        for (const record of await invocationRecords(stack.ready.invocation)) {
          if (record.kind === "root")
            await expect(access(record.root)).rejects.toMatchObject({
              code: "ENOENT",
            });
        }
      } catch (error) {
        throw new Error(`O-signal ${signal} failed\n${stack.output()}`, {
          cause: error,
        });
      } finally {
        await disposeNestedStack(stack, directory);
      }
    },
    600_000,
  );

  it("O1: worker SIGKILL makes the real lane reap un-watched supervisor/web groups, remove roots and fail", async () => {
    const directory = await mkdtemp(
      path.join(
        process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
        "s52-runner-control-",
      ),
    );

    await buildProductionWeb(path.join(directory, "next-build.log"));
    const stack = await nestedStack("unwatched", directory);
    const sibling = await createInvocation(directory);
    const other = await startIdleChild({
      ...process.env,
      ...invocationEnvironment(sibling),
    });

    try {
      process.kill(stack.ready.workerPid, "SIGKILL");
      expect(await stack.exited).not.toBe(0);
      expect(stack.output()).toContain('"event":"sweep-kill"');
      expect(stack.output()).toContain('"outcome":"leak-reaped"');
      expect(
        (await readProcessSnapshot(stack.ready.invocation)).filter(
          (entry) => entry.owned && !entry.zombie,
        ),
      ).toEqual([]);
      for (const record of await invocationRecords(stack.ready.invocation)) {
        if (record.kind === "root")
          await expect(access(record.root)).rejects.toMatchObject({
            code: "ENOENT",
          });
      }
      expect(other.exitCode).toBeNull();
    } catch (error) {
      throw new Error(`O1 failed\n${stack.output()}`, { cause: error });
    } finally {
      await stopIdleChild(other);
      await disposeNestedStack(stack, directory);
    }
  }, 600_000);

  it("O1-default: worker SIGKILL remains a failed lane with both cleanup guards enabled", async () => {
    const directory = await mkdtemp(
      path.join(
        process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
        "s52-combined-control-",
      ),
    );

    await buildProductionWeb(path.join(directory, "next-build.log"));
    const stack = await nestedStack("held", directory);

    try {
      process.kill(stack.ready.workerPid, "SIGKILL");
      expect(await stack.exited).not.toBe(0);
      expect(stack.output()).toContain("A/B integration runner failed");
      expect(
        (await readProcessSnapshot(stack.ready.invocation)).filter(
          (entry) => entry.owned && !entry.zombie,
        ),
      ).toEqual([]);
    } catch (error) {
      throw new Error(`O1-default failed\n${stack.output()}`, { cause: error });
    } finally {
      await disposeNestedStack(stack, directory);
    }
  }, 600_000);

  it("O2: parent death kills the real supervisor and its TERM-resistant adapter without an exit sweep", async () => {
    const directory = await mkdtemp(
      path.join(
        process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
        "s52-parent-control-",
      ),
    );
    const invocation = await createInvocation(directory);
    const parent = spawn(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL("../fixtures/process-cleanup-parent.ts", import.meta.url),
        ),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(await fixtureProcessEnvironment(invocation)),
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let diagnostics = "";

    parent.stderr?.on("data", (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16 * 1024);
    });
    try {
      const ready = await new Promise<{
        supervisorPid: number;
        adapterPid: number;
        runtimeRoot: string;
      }>((resolve, reject) => {
        parent.once("message", (message) =>
          resolve(
            message as {
              supervisorPid: number;
              adapterPid: number;
              runtimeRoot: string;
            },
          ),
        );
        parent.once("error", reject);
        parent.once("exit", (code, signal) =>
          reject(
            new Error(
              `cleanup parent exited before readiness: ${code}/${signal}\n${diagnostics}`,
            ),
          ),
        );
      });
      const before = await readProcessSnapshot(invocation);

      expect(
        before.find((entry) => entry.pid === ready.adapterPid)?.owned,
      ).toBe(true);
      process.kill(ready.adapterPid, "SIGTERM");
      expect(
        (await readProcessSnapshot(invocation)).find(
          (entry) => entry.pid === ready.adapterPid,
        )?.zombie,
      ).toBe(false);
      await stopIdleChild(parent);
      await expect
        .poll(
          async () =>
            (await readProcessSnapshot(invocation))
              .filter((entry) => entry.owned && !entry.zombie)
              .map((entry) => entry.pid),
          { timeout: 5_000, interval: 100 },
        )
        .toEqual([]);
      // The assertion above precedes the containment sweep: reaping cannot mask a failed watchdog.
    } catch (error) {
      for (const record of await invocationRecords(invocation)) {
        if (record.kind === "process" && record.logFile)
          diagnostics += await readLogTail(record.logFile);
      }
      throw new Error(`O2 failed\n${diagnostics}`, { cause: error });
    } finally {
      await stopIdleChild(parent);
      await sweepInvocation(invocation);
      await removeInvocationRoots(invocation);
      if (!process.env.MAISTER_TEST_EVIDENCE_DIR)
        await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it("O-identity: exact environment tags exclude argv decoys and sibling invocations, and PID reuse refuses ownership", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "s52-process-control-"),
    );
    const invocation = await createInvocation(directory);
    const sibling = await createInvocation(directory);
    const children: ChildProcess[] = [];

    try {
      const owned = await startIdleChild({
        ...process.env,
        ...invocationEnvironment(invocation),
      });

      children.push(owned);
      const other = await startIdleChild({
        ...process.env,
        ...invocationEnvironment(sibling),
      });

      children.push(other);
      const decoyEnv = { ...process.env };

      delete decoyEnv.MAISTER_TEST_WORKTREE_INVOCATION_ID;
      const decoy = await startIdleChild(decoyEnv, [
        `MAISTER_TEST_WORKTREE_INVOCATION_ID=${invocation.id}`,
      ]);

      children.push(decoy);
      const snapshot = await readProcessSnapshot(invocation);

      expect(
        snapshot.filter((entry) => entry.owned).map((entry) => entry.pid),
      ).toEqual([owned.pid]);
      expect(snapshot.find((entry) => entry.pid === decoy.pid)?.owned).toBe(
        false,
      );
      expect(snapshot.find((entry) => entry.pid === other.pid)?.owned).toBe(
        false,
      );
      const record = await registerProcess(
        invocation,
        {
          role: "fixture",
          caseName: "O-identity",
          rootRole: "none",
          root: null,
          bootId: "identity-control",
          logFile: null,
        },
        owned.pid!,
      );

      // A real PID reuse cannot be forced inside a test, so this is a PURE
      // control over the comparison that decides ownership: the same pid with a
      // different start time is a DIFFERENT process. It is not evidence that a
      // reused pid was observed in the wild.
      expect(
        sameProcess(record.identity, { ...record.identity, started: "reused" }),
      ).toBe(false);
      await expect(
        registerProcess(
          invocation,
          {
            role: "fixture",
            caseName: "O-identity",
            rootRole: "none",
            root: null,
            bootId: "foreign-control",
            logFile: null,
          },
          other.pid!,
        ),
      ).rejects.toThrow("lacks the exact invocation environment tag");
      expect(other.exitCode).toBeNull();
      expect(decoy.exitCode).toBeNull();
      // The deny-process-info probe below is macOS-only. The isolation lane is
      // macOS-only by design (`process-isolation.ts` refuses a host it cannot
      // enforce; Linux is S5.3), so say that rather than letting the host fail
      // with a bare ENOENT on a missing `sandbox-exec`.
      expect(
        process.platform,
        "O-identity's process-info denial probe requires macOS sandbox-exec",
      ).toBe("darwin");

      const readerUrl = new URL("../process-invocation.ts", import.meta.url)
        .href;
      const probe = `const reader = await import(${JSON.stringify(readerUrl)}); await reader.processIdentity(${JSON.stringify(invocation)}, ${owned.pid});`;

      await expect(
        execFileAsync(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            "(version 1)(allow default)(deny process-info*)",
            process.execPath,
            "--input-type=module",
            "-e",
            probe,
          ],
          {
            env: { ...process.env, ...invocationEnvironment(invocation) },
            timeout: 10_000,
          },
        ),
      ).rejects.toThrow("could not be inspected");
      expect(owned.exitCode).toBeNull();
    } finally {
      await Promise.all(children.map(stopIdleChild));
      if (!process.env.MAISTER_TEST_EVIDENCE_DIR)
        await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
