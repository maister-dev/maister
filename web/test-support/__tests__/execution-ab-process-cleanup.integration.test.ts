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
  readFile,
  unlink,
  chmod,
  readdir,
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
  registerSpawnedProcess,
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
  signalInvocationGroup,
  signalInvocationProcess,
  assertInvocationGroupEmpty,
  FIXTURE_WATCHDOG,
  releaseInvocation,
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

async function assertMissingBuildLockIdentity(
  invocation: Invocation,
  directory: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      FIXTURE_WATCHDOG,
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(
        new URL("../fixtures/build-lock-refusal.mjs", import.meta.url),
      ),
      path.join(directory, "missing-owner-build.log"),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...(await fixtureProcessEnvironment(invocation)) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let diagnostics = "";
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  child.stdout!.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8192);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-8192);
  });
  try {
    await registerSpawnedProcess(
      invocation,
      {
        role: "fixture",
        caseName: "O-build-lock missing identity",
        rootRole: "build-lock-control",
        root: null,
        bootId: String(child.pid),
        logFile: null,
      },
      child,
    );
    const result = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "missing build-lock identity did not refuse within 20000ms",
              ),
            ),
          20_000,
        );
      }),
    ]);

    expect(result, diagnostics).toEqual({ code: 0, signal: null });
    expect(JSON.parse(output.trim())).toEqual({
      event: "build-lock-missing-identity",
      outcome: "refused",
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.pid && child.exitCode === null && child.signalCode === null)
      await signalInvocationGroup(invocation, child.pid, "SIGKILL");
    await closed;
    if (child.pid) await assertInvocationGroupEmpty(invocation, child.pid);
  }
}

describe("S5.2 invocation process ownership", () => {
  it("O-build-lock: a proved dead owner is reclaimed and the verified artifact is reused", async () => {
    const directory = await mkdtemp(
      path.join(
        process.env.MAISTER_TEST_EVIDENCE_DIR ?? tmpdir(),
        "s52-build-lock-",
      ),
    );
    const invocation = await createInvocation(directory);
    const child = await startIdleChild({
      ...process.env,
      ...invocationEnvironment(invocation),
    });
    const lock = path.join(process.cwd(), ".next.build-lock");
    const ownerFile = path.join(invocation.directory, "dead-build-owner.json");

    try {
      const owner = await processIdentity(invocation, child.pid!);

      await writeFile(ownerFile, JSON.stringify(owner));
      await symlink(ownerFile, lock);
      await stopIdleChild(child);
      await unlink(ownerFile);
      await assertMissingBuildLockIdentity(invocation, directory);
      expect(await readlink(lock)).toBe(ownerFile);
      await unlink(lock);
      const buildId = await buildProductionWeb(
        path.join(directory, "next-build.log"),
      );

      await writeFile(ownerFile, JSON.stringify(owner));
      await symlink(ownerFile, lock);
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
      await expect(
        signalInvocationGroup(invocation, other.pid!, "SIGTERM"),
      ).rejects.toThrow("refusing unverifiable fixture group");
      // Observe signal delivery before asserting survival; exitCode alone can
      // still be null while the child's exit event is queued in this process.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await processIdentity(invocation, other.pid!)).toMatchObject({
        pid: other.pid,
        owned: false,
        inspected: true,
        zombie: false,
      });
      expect(other.exitCode).toBeNull();
      expect(decoy.exitCode).toBeNull();
      if (process.platform === "linux") {
        const executable = path.join(directory, "process-info-denied");
        const source = fileURLToPath(
          new URL("../fixtures/process-info-denied.c", import.meta.url),
        );

        await execFileAsync(
          "cc",
          ["-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", executable],
          {
            timeout: 10_000,
            maxBuffer: 16 * 1024,
          },
        );
        const denied = spawn(executable, [], {
          env: { ...process.env, ...invocationEnvironment(invocation) },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        children.push(denied);
        if (!denied.stdout)
          throw new Error("inspection-denial readiness pipe is missing");
        const readiness = await Promise.race([
          once(denied.stdout, "data"),
          new Promise<never>((_resolve, reject) => {
            const timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "inspection-denial fixture did not reach prctl readiness",
                  ),
                ),
              10_000,
            );

            denied.once("close", () => {
              clearTimeout(timeout);
              reject(
                new Error("inspection-denial fixture exited before readiness"),
              );
            });
            denied.stdout!.once("data", () => clearTimeout(timeout));
          }),
        ]);

        expect(readiness[0].toString()).toBe(`denied:${denied.pid}\n`);
        await expect(
          readFile(`/proc/${denied.pid}/environ`).then((bytes) => bytes.length),
        ).rejects.toMatchObject({ code: "EACCES" });
        await expect(
          registerProcess(
            invocation,
            {
              role: "fixture",
              caseName: "O-identity",
              rootRole: "none",
              root: null,
              bootId: "uninspectable",
              logFile: null,
            },
            denied.pid!,
          ),
        ).rejects.toThrow(
          /could not be inspected|lacks the exact invocation environment tag/u,
        );
        await expect(
          signalInvocationProcess(
            invocation,
            { ...record.identity, pid: denied.pid! },
            "SIGTERM",
          ),
        ).rejects.toThrow(/could not be inspected|uninspectable/u);
        expect(denied.exitCode).toBeNull();
        expect(other.exitCode).toBeNull();

        return;
      }
      expect(
        process.platform,
        "O-identity requires a supported process-inspection platform",
      ).toBe("darwin");

      const transitionExecutable = path.join(
        directory,
        "process-info-transition",
      );
      const transitionSource = fileURLToPath(
        new URL("../fixtures/process-info-transition.c", import.meta.url),
      );

      await execFileAsync(
        "cc",
        [
          "-Wall",
          "-Wextra",
          "-Werror",
          "-O2",
          transitionSource,
          "-o",
          transitionExecutable,
        ],
        { timeout: 10_000, maxBuffer: 16 * 1024 },
      );
      const parseTransitionReceipt = (
        diagnostics: string,
      ): Readonly<{
        pid: string;
        infoReads: number;
        firstStatus: number;
        secondStatus: number;
        catalogueCalls: number;
        catalogueDenied: number;
      }> => {
        const match =
          /\{"event":"native-transition-control","pid":(\d+),"infoReads":(\d+),"firstStatus":(\d+),"secondStatus":(\d+),"catalogueCalls":(\d+),"catalogueDenied":([01])\}/u.exec(
            diagnostics,
          );

        if (!match)
          throw new Error("native transition control receipt is missing");

        return {
          pid: match[1]!,
          infoReads: Number(match[2]),
          firstStatus: Number(match[3]),
          secondStatus: Number(match[4]),
          catalogueCalls: Number(match[5]),
          catalogueDenied: Number(match[6]),
        };
      };
      const transitionControls = [
        { boundary: "status", query: invocation.id, owned: "1", calls: 0 },
        {
          boundary: "environment",
          query: invocation.id,
          owned: null,
          calls: 2,
        },
        {
          boundary: "selected-catalogue",
          query: invocation.id,
          owned: "1",
          calls: 0,
        },
        {
          boundary: "selected-catalogue",
          query: sibling.id,
          owned: "0",
          calls: 0,
        },
        {
          boundary: "selected-inspector",
          query: invocation.id,
          owned: "0",
          calls: 0,
        },
        {
          boundary: "selected-inspector",
          query: sibling.id,
          owned: "0",
          calls: 0,
        },
        {
          boundary: "snapshot-inspector",
          query: invocation.id,
          owned: null,
          calls: 2,
        },
      ] as const;

      for (const control of transitionControls) {
        const transition = await execFileAsync(
          transitionExecutable,
          [control.query, control.boundary],
          {
            env: { ...process.env, ...invocationEnvironment(invocation) },
            timeout: 10_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        const receipt = parseTransitionReceipt(transition.stderr);
        const row = transition.stdout
          .trim()
          .split("\n")
          .find((line) => line.startsWith(`${receipt.pid}\t`))
          ?.split("\t");

        expect(receipt.catalogueCalls).toBe(control.calls);
        expect(receipt.catalogueDenied).toBe(
          control.boundary === "selected-catalogue" ? 1 : 0,
        );
        if (control.owned !== null) {
          expect(receipt.infoReads).toBe(2);
          expect(receipt.firstStatus).toBeGreaterThan(0);
          expect(receipt.firstStatus).toBeLessThan(4);
          expect(receipt.secondStatus, "the kernel observed SIGSTOP").toBe(4);
          expect(
            row?.[2],
            "the revalidated process group follows the child's real setpgid",
          ).toBe(receipt.pid);
          expect(
            row?.[6],
            "the reader publishes the revalidated kernel status",
          ).toBe("4");
          expect(row?.[5]).toBe(control.owned);
        } else if (control.boundary === "snapshot-inspector") {
          expect(
            row,
            "full snapshots exclude helpers from group ownership",
          ).toBeUndefined();
        } else {
          expect(transition.stderr).toMatch(
            new RegExp(
              `process-inspection-failed","pid":${receipt.pid},"stage":"kern_procargs","result":-\\d+,"expected":0,"errno":\\d+`,
              "u",
            ),
          );
        }
      }
      await expect(
        execFileAsync(
          transitionExecutable,
          [invocation.id, "snapshot-catalogue"],
          {
            env: { ...process.env, ...invocationEnvironment(invocation) },
            timeout: 10_000,
            maxBuffer: 16 * 1024,
          },
        ),
      ).rejects.toMatchObject({
        code: 70,
        stderr: expect.stringMatching(
          /"stage":"proc_listpids_size".*"errno":1/u,
        ),
      });
      const inspector = await startIdleChild({
        ...process.env,
        ...invocationEnvironment(invocation),
        MAISTER_TEST_PROCESS_INSPECTOR: invocation.id,
      });

      children.push(inspector);
      const inspectorIdentity = await processIdentity(
        invocation,
        inspector.pid!,
      );

      expect(inspectorIdentity).toMatchObject({
        pid: inspector.pid,
        owned: false,
        inspected: true,
        zombie: false,
      });
      await expect(
        signalInvocationProcess(invocation, inspectorIdentity, "SIGTERM"),
      ).rejects.toThrow(
        "refusing signal to changed, foreign or uninspectable process identity",
      );
      expect(await processIdentity(invocation, inspector.pid!)).toEqual(
        inspectorIdentity,
      );

      const watchdogInvocation = await createInvocation(directory);
      let watchdog: ChildProcess | undefined;
      let watchdogReader: string | undefined;

      try {
        const watchdogEnvironment =
          await fixtureProcessEnvironment(watchdogInvocation);
        const spawnedWatchdog = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            FIXTURE_WATCHDOG,
            "-e",
            'process.stderr.write("inspection-control-ready\\n"); setInterval(() => {}, 60000);',
          ],
          {
            env: { ...process.env, ...watchdogEnvironment },
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
          },
        );

        watchdog = spawnedWatchdog;
        children.push(spawnedWatchdog);
        let watchdogOutput = "";
        const watchdogExited = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          spawnedWatchdog.once("error", reject);
          spawnedWatchdog.once("close", (code, signal) =>
            resolve({ code, signal }),
          );
        });

        // Observe startup failure immediately; the awaited promise retains it.
        void watchdogExited.catch(() => undefined);

        spawnedWatchdog.stderr!.on("data", (chunk: Buffer) => {
          watchdogOutput = `${watchdogOutput}${chunk.toString()}`.slice(
            -32 * 1024,
          );
        });
        await registerSpawnedProcess(
          watchdogInvocation,
          {
            role: "fixture",
            caseName: "O-identity",
            rootRole: "none",
            root: null,
            bootId: "watchdog-inspection-refusal",
            logFile: null,
          },
          spawnedWatchdog,
        );
        await expect
          .poll(() => watchdogOutput.includes("inspection-control-ready"), {
            timeout: 10_000,
            interval: 50,
          })
          .toBe(true);
        const executableName = (
          await readdir(watchdogInvocation.directory)
        ).find((name) => /^process-environment-[a-f0-9]{16}$/u.test(name));

        if (!executableName)
          throw new Error("watchdog native reader is missing");
        watchdogReader = path.join(
          watchdogInvocation.directory,
          executableName,
        );

        await chmod(watchdogReader, 0o000);
        await expect
          .poll(() => spawnedWatchdog.signalCode, {
            timeout: 10_000,
            interval: 50,
          })
          .toBe("SIGKILL");
        expect(await watchdogExited).toEqual({ code: null, signal: "SIGKILL" });
        const receiptLine = watchdogOutput
          .split("\n")
          .find((line) => line.includes('"event":"fixture-watchdog-error"'));

        if (!receiptLine)
          throw new Error(
            `watchdog failure receipt is missing\n${watchdogOutput}`,
          );
        const receipt = JSON.parse(receiptLine) as {
          invocationId: string;
          owner: { pid: number; started: string };
          parent: { pid: number; started: string };
          causes: { code: string | null }[];
        };

        expect(receipt.invocationId).toBe(watchdogInvocation.id);
        expect(receipt.owner).toMatchObject(
          JSON.parse(watchdogEnvironment.MAISTER_TEST_PROCESS_OWNER!),
        );
        expect(receipt.parent).toMatchObject(
          JSON.parse(watchdogEnvironment.MAISTER_TEST_PROCESS_PARENT!),
        );
        expect(receipt.causes.some((cause) => cause.code === "EACCES")).toBe(
          true,
        );
        expect(await processIdentity(invocation, owned.pid!)).toMatchObject(
          record.identity,
        );
        expect(other.exitCode).toBeNull();
        expect(decoy.exitCode).toBeNull();
      } finally {
        if (watchdogReader) await chmod(watchdogReader, 0o755);
        if (watchdog) await stopIdleChild(watchdog);
        const cleanupErrors = await releaseInvocation(
          watchdogInvocation,
          "watchdog inspection control",
        );

        if (cleanupErrors.length)
          throw new AggregateError(
            cleanupErrors,
            "watchdog inspection control cleanup failed",
          );
      }

      const readerUrl = new URL("../process-invocation.ts", import.meta.url)
        .href;
      const probe = `const reader = await import(${JSON.stringify(readerUrl)}); await reader.processIdentity(${JSON.stringify(invocation)}, ${owned.pid});`;

      const deniedInspection = execFileAsync(
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
      );

      await expect(deniedInspection).rejects.toThrow("could not be inspected");
      await expect(deniedInspection).rejects.toMatchObject({
        stderr: expect.stringMatching(
          /process-inspection-failed.*stage\\?":\\?"[a-z_]+.*errno\\?":\d+/u,
        ),
      });
      expect(owned.exitCode).toBeNull();
    } finally {
      await Promise.all(children.map(stopIdleChild));
      if (!process.env.MAISTER_TEST_EVIDENCE_DIR)
        await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
