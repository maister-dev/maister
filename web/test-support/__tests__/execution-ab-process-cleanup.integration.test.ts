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
  copyFile,
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
  type ProcessIdentity,
  registerRoot,
  processIdentity,
  findProcessIdentities,
  signalInvocationGroup,
  signalInvocationProcess,
  signalCheckedInvocationGroup,
  processGroupRetired,
  logInvocation,
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

async function assertDarwinInspectorTransportRetries(
  invocation: Invocation,
  owned: ProcessIdentity,
  foreign: ProcessIdentity,
  directory: string,
): Promise<void> {
  const executable = path.join(directory, "process-transport-failure");

  await execFileAsync("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    fileURLToPath(
      new URL("../fixtures/process-transport-failure.c", import.meta.url),
    ),
    "-o",
    executable,
  ]);
  const name = (await readdir(invocation.directory)).find((entry) =>
    /^process-environment-[a-f0-9]{16}$/u.test(entry),
  );

  if (!name) throw new Error("transport-control native reader is missing");
  const reader = path.join(invocation.directory, name);
  const original = `${reader}.transport-original`;
  const replacement = `${reader}.transport-control`;
  const controlFile = path.join(
    invocation.directory,
    "process-transport-control",
  );

  await copyFile(executable, replacement);
  await rename(reader, original);
  try {
    await rename(replacement, reader);
    const controls = [
      { mode: 1, failures: 1, calls: 2, signal: "SIGPIPE", code: null },
      { mode: 1, failures: -1, calls: 2, signal: "SIGPIPE", code: null },
      { mode: 2, failures: -1, calls: 1, signal: null, code: 70 },
      { mode: 3, failures: -1, calls: 1, signal: null, code: null },
      { mode: 4, failures: -1, calls: 1, signal: "SIGTERM", code: null },
    ] as const;
    const moduleUrl = new URL("../process-invocation.ts", import.meta.url).href;
    const source = `const reader = await import(${JSON.stringify(moduleUrl)}); try { const identities = await reader.findProcessIdentities(${JSON.stringify(invocation)}, ${JSON.stringify([foreign.pid, owned.pid, owned.pid])}); process.stdout.write(JSON.stringify({ identities })); } catch (error) { const cause = error.cause; process.stdout.write(JSON.stringify({ error: { name: error.name, message: error.message, cause: cause ? { code: cause.code ?? null, signal: cause.signal ?? null, killed: cause.killed ?? null, stderr: cause.stderr ?? null } : null } })); }`;

    for (const control of controls) {
      await writeFile(controlFile, `${control.mode} ${control.failures} 0\n`, {
        mode: 0o600,
      });
      const probe = await execFileAsync(
        process.execPath,
        ["--input-type=module", "-e", source],
        {
          env: { ...process.env, ...invocationEnvironment(invocation) },
          timeout: 10_000,
          maxBuffer: 32 * 1024,
        },
      );
      const result = JSON.parse(probe.stdout) as Readonly<{
        identities?: readonly (ProcessIdentity | null)[];
        error?: Readonly<{
          name: string;
          message: string;
          cause: Readonly<{
            code: string | number | null;
            signal: string | null;
            killed: boolean | null;
            stderr: string | null;
          }> | null;
        }>;
      }>;
      const calls = Number(
        (await readFile(controlFile, "utf8")).trim().split(/\s+/u)[2],
      );
      const recovered = control.mode === 1 && control.failures === 1;

      expect
        .soft(calls, `native transport mode ${control.mode}`)
        .toBe(control.calls);
      if (recovered) {
        expect.soft(result.error).toBeUndefined();
        expect.soft(result.identities).toEqual([foreign, owned, owned]);
      } else if (control.mode === 3) {
        expect.soft(result.error).toMatchObject({
          name: "InvocationOwnershipError",
          message: "malformed native process identity",
          cause: null,
        });
      } else {
        expect.soft(result.error).toMatchObject({
          name: "InvocationOwnershipError",
          cause: {
            code: control.code,
            signal: control.signal,
            killed: false,
            stderr: expect.stringContaining(`"call":${control.calls}`),
          },
        });
      }
      const diagnostics = probe.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line: string) =>
            JSON.parse(line) as Readonly<{
              event: string;
              level?: string;
              attempt?: number;
              attempts?: number;
              elapsedMs?: number;
              selectedPids?: readonly number[];
              code?: string | number | null;
              signal?: string | null;
              killed?: boolean | null;
              retrying?: boolean;
            }>,
        )
        .filter((event) => event.event === "process-inspection-command-failed");

      expect
        .soft(diagnostics)
        .toHaveLength(control.mode === 3 ? 0 : recovered ? 1 : control.calls);
      for (const [index, diagnostic] of diagnostics.entries()) {
        expect.soft(diagnostic).toMatchObject({
          level: "warn",
          attempt: index + 1,
          attempts: 2,
          elapsedMs: expect.any(Number),
          selectedPids: [foreign.pid, owned.pid],
          code: control.code,
          signal: control.signal,
          killed: false,
          retrying: control.mode === 1 && index === 0,
        });
        expect.soft(Number(diagnostic.elapsedMs)).toBeGreaterThanOrEqual(0);
      }
    }
  } finally {
    await rm(reader, { force: true });
    await rename(original, reader);
    await rm(controlFile, { force: true });
    await rm(replacement, { force: true });
  }
  expect(await processIdentity(invocation, owned.pid)).toEqual(owned);
  expect(await processIdentity(invocation, foreign.pid)).toEqual(foreign);
}

async function assertWatchdogInspectionFailureGroups(
  directory: string,
): Promise<void> {
  const executable = path.join(directory, "selected-info-denied");

  await execFileAsync("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    fileURLToPath(
      new URL("../fixtures/process-selected-info-denied.c", import.meta.url),
    ),
    "-o",
    executable,
  ]);
  for (const membership of ["owned", "foreign"] as const) {
    const invocation = await createInvocation(directory);
    const childInvocation =
      membership === "owned" ? invocation : await createInvocation(directory);
    const environment = await fixtureProcessEnvironment(invocation);
    const source = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, MAISTER_TEST_WORKTREE_INVOCATION_ID: ${JSON.stringify(childInvocation.id)} }, stdio: "ignore" }); child.once("spawn", () => process.stderr.write(JSON.stringify({ event: "unwatched-child-ready", pid: child.pid }) + "\\n")); setInterval(() => {}, 1000);`;
    const watchdog = spawn(
      process.execPath,
      ["--import", "tsx", "--import", FIXTURE_WATCHDOG, "-e", source],
      {
        env: { ...process.env, ...environment },
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let output = "";
    let reader: string | undefined;
    let original: string | undefined;
    let childIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined;

    watchdog.stderr!.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-32 * 1024);
    });
    try {
      await expect
        .poll(() => output.includes('"event":"unwatched-child-ready"'), {
          timeout: 5_000,
          interval: 50,
        })
        .toBe(true);
      const ready = output
        .split("\n")
        .find((line) => line.includes('"event":"unwatched-child-ready"'));

      if (!ready) throw new Error("unwatched child readiness is missing");
      childIdentity = await processIdentity(
        childInvocation,
        (JSON.parse(ready) as { pid: number }).pid,
      );
      const parentIdentity = await processIdentity(invocation, watchdog.pid!);

      expect(childIdentity.pgid).toBe(parentIdentity.pgid);
      const name = (await readdir(invocation.directory)).find((entry) =>
        /^process-environment-[a-f0-9]{16}$/u.test(entry),
      );

      if (!name) throw new Error("selected-denial reader is missing");
      reader = path.join(invocation.directory, name);
      original = `${reader}.original`;
      await copyFile(reader, original);
      const replacement = `${reader}.selected-denied`;

      await copyFile(executable, replacement);
      await rename(replacement, reader);
      await expect
        .poll(() => watchdog.signalCode, { timeout: 5_000, interval: 50 })
        .toBe("SIGKILL");
      expect(output).toContain('"event":"fixture-watchdog-error"');
      // Restore selected inspection before checking the real child's identity.
      await rename(original, reader);
      original = undefined;
      const expected = membership === "owned" ? [] : [childIdentity.pid];

      await expect
        .poll(
          async () =>
            (await readProcessSnapshot(childInvocation))
              .filter(
                (entry) =>
                  entry.owned &&
                  !entry.zombie &&
                  entry.pid === childIdentity!.pid,
              )
              .map((entry) => entry.pid),
          { timeout: 5_000, interval: 50 },
        )
        .toEqual(expected);
    } finally {
      if (original && reader) await rename(original, reader);
      await stopIdleChild(watchdog);
      if (childIdentity) {
        const current = (await readProcessSnapshot(childInvocation)).find(
          (entry) => entry.pid === childIdentity!.pid && !entry.zombie,
        );

        if (current)
          await signalInvocationProcess(
            childInvocation,
            childIdentity,
            "SIGKILL",
          );
        await expect
          .poll(
            async () =>
              (await readProcessSnapshot(childInvocation)).some(
                (entry) => entry.pid === childIdentity!.pid && !entry.zombie,
              ),
            { timeout: 5_000, interval: 50 },
          )
          .toBe(false);
      }
      const failures = await releaseInvocation(
        invocation,
        "selected inspection refusal control",
      );

      if (failures.length)
        throw new AggregateError(
          failures,
          "selected inspection refusal cleanup failed",
        );
      if (childInvocation !== invocation) {
        const siblingFailures = await releaseInvocation(
          childInvocation,
          "foreign child refusal control",
        );

        if (siblingFailures.length)
          throw new AggregateError(
            siblingFailures,
            "foreign child refusal cleanup failed",
          );
      }
    }
  }
}

async function installEnvironmentReadDenial(
  invocation: Invocation,
  pid: number,
  executable: string,
): Promise<() => Promise<void>> {
  const name = (await readdir(invocation.directory)).find((entry) =>
    /^process-environment-[a-f0-9]{16}$/u.test(entry),
  );

  if (!name) throw new Error("environment-denial reader is missing");
  const reader = path.join(invocation.directory, name);
  const original = `${reader}.original`;
  const replacement = `${reader}.denied`;
  const control = path.join(
    invocation.directory,
    "process-environment-denied-pid",
  );

  await copyFile(executable, replacement);
  await writeFile(control, String(pid), { flag: "wx", mode: 0o600 });
  await rename(reader, original);
  try {
    await rename(replacement, reader);
  } catch (error) {
    await rename(original, reader);
    throw error;
  }

  return async () => {
    await rm(reader);
    await rename(original, reader);
    await rm(control);
  };
}

async function assertDarwinGroupRetirement(
  invocation: Invocation,
  sibling: Invocation,
  directory: string,
): Promise<void> {
  const executable = path.join(directory, "process-group-transition");
  const source = fileURLToPath(
    new URL("../fixtures/process-group-transition.c", import.meta.url),
  );

  await execFileAsync(
    "cc",
    ["-Wall", "-Wextra", "-Werror", "-O2", source, "-o", executable],
    {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    },
  );
  for (const kind of ["owned", "inspector"] as const) {
    const control = spawn(executable, [invocation.id, kind], {
      env: { ...process.env, ...invocationEnvironment(sibling) },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(control, "exit");

    void exited.catch(() => {});
    let zombie = false;

    try {
      const [readyData] = await once(control.stdout, "data", {
        signal: AbortSignal.timeout(5_000),
      });
      const ready = JSON.parse(String(readyData)) as {
        event: string;
        pid: number;
      };

      expect(ready.event).toBe("group-transition-ready");
      expect(Number.isSafeInteger(ready.pid) && ready.pid > 1).toBe(true);
      const members = (await readProcessSnapshot(invocation)).filter(
        (entry) => entry.pgid === ready.pid && !entry.zombie,
      );

      if (kind === "owned") {
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({
          pid: ready.pid,
          owned: true,
          inspected: true,
        });
        const modulePath = fileURLToPath(
          new URL("../process-invocation.ts", import.meta.url),
        );
        const denial = await execFileAsync(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            "(version 1)(allow default)(deny signal)",
            process.execPath,
            "--import",
            createRequire(import.meta.url).resolve("tsx"),
            "--input-type=module",
            "-e",
            `import {signalInvocationGroup} from ${JSON.stringify(modulePath)};
const invocation = JSON.parse(process.argv[1]);
try {
  await signalInvocationGroup(invocation, Number(process.argv[2]), "SIGTERM");
  throw new Error("live group signal denial was hidden");
} catch (error) {
  if (error.code !== "EPERM") throw error;
  process.stdout.write(JSON.stringify({event:"group-signal-denied",code:error.code}) + "\\n");
}`,
            JSON.stringify(invocation),
            String(ready.pid),
          ],
          { timeout: 10_000, maxBuffer: 16 * 1024 },
        );

        expect(JSON.parse(denial.stdout)).toEqual({
          event: "group-signal-denied",
          code: "EPERM",
        });
        expect(await processIdentity(invocation, ready.pid)).toMatchObject({
          owned: true,
          inspected: true,
          zombie: false,
        });
      } else {
        expect(members).toEqual([]);
        expect(await processIdentity(invocation, ready.pid)).toMatchObject({
          owned: false,
          inspected: true,
          zombie: false,
        });
      }
      // The unfiltered kernel proof must see a live inspector omitted by the ownership reader.
      expect(await processGroupRetired(invocation, ready.pid)).toBe(false);
      const zombieData = once(control.stdout, "data", {
        signal: AbortSignal.timeout(5_000),
      });

      control.stdin.write("z");
      const [receiptData] = await zombieData;
      const receipt = JSON.parse(String(receiptData)) as {
        event: string;
        pid: number;
        status: number;
      };

      expect(receipt).toEqual({
        event: "group-transition-zombie",
        pid: ready.pid,
        status: 5,
      });
      zombie = true;
      expect(await processGroupRetired(invocation, ready.pid)).toBe(true);
      if (kind === "owned") {
        // Real identities were captured while live. The barrier schedules death
        // between that ownership read and the real group syscall, with no reaping.
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          let failure: unknown;

          try {
            process.kill(-ready.pid, signal);
          } catch (error) {
            failure = error;
          }
          expect(failure).toMatchObject({ code: "EPERM", syscall: "kill" });
          logInvocation(invocation, "native-group-retirement-control", {
            pgid: ready.pid,
            signal,
            status: receipt.status,
            errorCode: "EPERM",
            outcome: "observed",
          });
          await expect(
            signalCheckedInvocationGroup(
              invocation,
              ready.pid,
              members,
              signal,
            ),
          ).resolves.toBeUndefined();
        }
        const livenessProgram = (await readdir(invocation.directory)).find(
          (file) => /^process-group-liveness-[a-f0-9]{16}$/u.test(file),
        );

        if (!livenessProgram)
          throw new Error("native group liveness executable is missing");
        const livenessPath = path.join(invocation.directory, livenessProgram);

        await chmod(livenessPath, 0o000);
        try {
          await expect(
            signalCheckedInvocationGroup(
              invocation,
              ready.pid,
              members,
              "SIGTERM",
            ),
          ).rejects.toMatchObject({
            cause: { code: "EPERM" },
            errors: [{ code: "EPERM" }, { code: "EACCES" }],
          });
        } finally {
          await chmod(livenessPath, 0o755);
        }
      }
    } finally {
      control.stdin.end(zombie ? "r" : "zr");
      expect(await exited).toEqual([0, null]);
    }
  }
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
    "O-exit: '$name' retains the exact outcome and finishes cleanup",
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
      const otherIdentity = await processIdentity(invocation, other.pid!);
      const decoyIdentity = await processIdentity(invocation, decoy.pid!);

      await expect(findProcessIdentities(invocation, [])).rejects.toThrow(
        "nonempty list of positive PIDs",
      );
      expect(
        await findProcessIdentities(invocation, [
          other.pid!,
          owned.pid!,
          decoy.pid!,
          owned.pid!,
        ]),
      ).toEqual([
        otherIdentity,
        record.identity,
        decoyIdentity,
        record.identity,
      ]);
      const gone = await startIdleChild({
        ...process.env,
        ...invocationEnvironment(invocation),
      });

      children.push(gone);
      await stopIdleChild(gone);
      expect(
        await findProcessIdentities(invocation, [
          owned.pid!,
          gone.pid!,
          other.pid!,
        ]),
      ).toEqual([record.identity, null, otherIdentity]);
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
        expect(
          await findProcessIdentities(invocation, [denied.pid!, owned.pid!]),
        ).toEqual([
          expect.objectContaining({
            pid: denied.pid,
            owned: false,
            inspected: false,
            zombie: false,
          }),
          record.identity,
        ]);
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

      const nativeReaderName = (await readdir(invocation.directory)).find(
        (name) => /^process-environment-[a-f0-9]{16}$/u.test(name),
      );

      if (!nativeReaderName)
        throw new Error("native identity reader is missing");
      const selectedPair = await execFileAsync(
        path.join(invocation.directory, nativeReaderName),
        [invocation.id, String(owned.pid), String(other.pid)],
        { env: { ...process.env, ...invocationEnvironment(invocation) } },
      );

      expect(
        selectedPair.stdout
          .trim()
          .split("\n")
          .map((line) => line.split("\t")[0]),
        "one native execution inspects both real selected PIDs",
      ).toEqual([String(owned.pid), String(other.pid)]);
      for (const [index, identity] of [
        record.identity,
        otherIdentity,
      ].entries()) {
        const fields = selectedPair.stdout
          .trim()
          .split("\n")
          [index]!.split("\t");

        expect(fields.slice(0, 6)).toEqual([
          String(identity.pid),
          String(identity.ppid),
          String(identity.pgid),
          String(identity.uid),
          identity.started,
          identity.owned ? "1" : "0",
        ]);
        expect(Number(fields[6])).toBeGreaterThan(0);
        expect(Number(fields[6])).toBeLessThan(5);
      }

      await assertDarwinInspectorTransportRetries(
        invocation,
        record.identity,
        otherIdentity,
        directory,
      );

      const environmentDeniedExecutable = path.join(
        directory,
        "process-environment-denied",
      );

      await execFileAsync(
        "cc",
        [
          "-Wall",
          "-Wextra",
          "-Werror",
          "-O2",
          fileURLToPath(
            new URL(
              "../fixtures/process-environment-denied.c",
              import.meta.url,
            ),
          ),
          "-o",
          environmentDeniedExecutable,
        ],
        { timeout: 10_000, maxBuffer: 16 * 1024 },
      );
      const restoreEnvironmentRead = await installEnvironmentReadDenial(
        invocation,
        owned.pid!,
        environmentDeniedExecutable,
      );

      try {
        expect(
          await findProcessIdentities(invocation, [owned.pid!, other.pid!]),
        ).toEqual([
          { ...record.identity, owned: false, inspected: false },
          otherIdentity,
        ]);
        await expect(
          registerProcess(
            invocation,
            {
              role: "fixture",
              caseName: "O-identity",
              rootRole: "none",
              root: null,
              bootId: "environment-denied",
              logFile: null,
            },
            owned.pid!,
          ),
        ).rejects.toThrow("lacks the exact invocation environment tag");
        await expect(
          signalInvocationProcess(invocation, record.identity, "SIGTERM"),
        ).rejects.toThrow(
          "refusing signal to changed, foreign or uninspectable process identity",
        );
        expect(owned.exitCode).toBeNull();
        expect(other.exitCode).toBeNull();
      } finally {
        await restoreEnvironmentRead();
      }

      const asymmetricInspector = await startIdleChild({
        ...process.env,
        ...invocationEnvironment(invocation),
        MAISTER_TEST_PROCESS_INSPECTOR: invocation.id,
      });

      children.push(asymmetricInspector);
      const asymmetricInspectorIdentity = await processIdentity(
        invocation,
        asymmetricInspector.pid!,
      );

      expect(asymmetricInspectorIdentity).toMatchObject({
        owned: false,
        inspected: true,
        zombie: false,
      });
      const inspectionControls = [
        {
          pid: owned.pid!,
          errno: 0,
          limit: 2,
          owned: true,
          inspected: true,
          calls: 4,
          retries: 2,
        },
        {
          pid: owned.pid!,
          errno: 22,
          limit: 2,
          owned: true,
          inspected: true,
          calls: 4,
          retries: 2,
        },
        {
          pid: owned.pid!,
          errno: 22,
          limit: -1,
          owned: false,
          inspected: false,
          calls: 6,
          retries: 4,
        },
        {
          pid: owned.pid!,
          errno: 13,
          limit: -1,
          owned: false,
          inspected: false,
          calls: 2,
          retries: 0,
        },
        {
          pid: owned.pid!,
          errno: 1,
          limit: -1,
          owned: false,
          inspected: false,
          calls: 2,
          retries: 0,
        },
        {
          pid: other.pid!,
          errno: 22,
          limit: 2,
          owned: false,
          inspected: true,
          calls: 4,
          retries: 2,
        },
        {
          pid: other.pid!,
          errno: 22,
          limit: 0,
          owned: false,
          inspected: true,
          calls: 2,
          retries: 0,
        },
        {
          pid: asymmetricInspector.pid!,
          errno: 22,
          limit: -1,
          after: 1,
          owned: false,
          inspected: false,
          calls: 4,
          retries: 2,
        },
        {
          pid: asymmetricInspector.pid!,
          errno: 13,
          limit: -1,
          after: 1,
          owned: false,
          inspected: false,
          calls: 2,
          retries: 0,
        },
      ] as const;

      for (const control of inspectionControls) {
        const restoreInspection = await installEnvironmentReadDenial(
          invocation,
          control.pid,
          environmentDeniedExecutable,
        );

        try {
          await writeFile(
            path.join(invocation.directory, "process-environment-denied-pid"),
            `${control.pid} ${control.errno} ${control.limit} ${"after" in control ? control.after : 0}`,
          );
          const inspected = await execFileAsync(
            path.join(invocation.directory, nativeReaderName),
            [invocation.id, String(control.pid)],
            {
              env: { ...process.env, ...invocationEnvironment(invocation) },
              timeout: 10_000,
              maxBuffer: 16 * 1024,
            },
          );
          const fields = inspected.stdout.trim().split("\t");
          const reference =
            control.pid === owned.pid
              ? record.identity
              : control.pid === other.pid
                ? otherIdentity
                : asymmetricInspectorIdentity;

          logInvocation(invocation, "native-inspection-read-control", {
            pid: control.pid,
            failureErrno: control.errno,
            failureLimit: control.limit,
            failureOffset: "after" in control ? control.after : 0,
            nativeRow: inspected.stdout.trim(),
            nativeDiagnostics: inspected.stderr.trim(),
          });
          expect(fields.slice(0, 5)).toEqual([
            String(reference.pid),
            String(reference.ppid),
            String(reference.pgid),
            String(reference.uid),
            reference.started,
          ]);
          // Soft assertions retain both real failure origins in RED while still failing this case.
          const signalFailure = await signalInvocationGroup(
            invocation,
            reference.pgid,
            "SIGCONT",
          ).then(
            () => null,
            (error: unknown) => error,
          );

          if (control.owned) expect.soft(signalFailure).toBeNull();
          else
            expect
              .soft(
                signalFailure instanceof Error &&
                  signalFailure.message.includes(
                    "refusing unverifiable fixture group",
                  ),
              )
              .toBe(true);
          expect
            .soft(fields[5] === "1", "retry never invents an invocation tag")
            .toBe(control.owned);
          expect
            .soft(
              Number(fields[5]) >= 0,
              "persistent failure remains uninspectable",
            )
            .toBe(control.inspected);
          const diagnostics = inspected.stderr
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line: string) =>
                JSON.parse(line) as Readonly<{
                  event: string;
                  pid: number;
                  call?: number;
                  stage?: string;
                  result: number;
                  expected?: number;
                  errno: number;
                }>,
            );
          const attempts = diagnostics.filter(
            (receipt) => receipt.event === "process-environment-control",
          );
          const retries = diagnostics.filter(
            (receipt) => receipt.stage === "kern_procargs_retry",
          );

          expect.soft(attempts).toHaveLength(control.calls);
          expect.soft(retries).toHaveLength(control.retries);
          expect
            .soft(
              retries.every(
                (receipt) =>
                  receipt.pid === control.pid &&
                  receipt.errno === 22 &&
                  receipt.result >= 1 &&
                  receipt.result <= 2 &&
                  receipt.expected === 3,
              ),
            )
            .toBe(true);
          process.stderr.write(
            `${JSON.stringify({ event: "native-inspection-retry-control", invocationId: invocation.id, pid: control.pid, errno: control.errno, failureLimit: control.limit, owned: fields[5] === "1", inspected: Number(fields[5]) >= 0, expectedOwned: control.owned, expectedInspected: control.inspected, attempts: attempts.length, retries: retries.length })}\n`,
          );
          expect(owned.exitCode).toBeNull();
          expect(other.exitCode).toBeNull();
        } finally {
          await restoreInspection();
        }
      }

      await assertDarwinGroupRetirement(invocation, sibling, directory);
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
        {
          boundary: "batch-status",
          query: invocation.id,
          owned: "1",
          calls: 0,
        },
        {
          boundary: "batch-environment",
          query: invocation.id,
          owned: null,
          calls: 0,
        },
        {
          boundary: "batch-catalogue",
          query: sibling.id,
          owned: "0",
          calls: 0,
        },
        {
          boundary: "batch-inspector",
          query: invocation.id,
          owned: "0",
          calls: 0,
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
          control.boundary === "selected-catalogue" ||
            control.boundary === "batch-catalogue"
            ? 1
            : 0,
        );
        if (control.boundary.startsWith("batch-")) {
          const peer = await processIdentity(invocation, process.pid);
          const peerRow = transition.stdout
            .trim()
            .split("\n")
            .find((line) => line.startsWith(`${process.pid}\t`))
            ?.split("\t");

          expect(peerRow?.slice(0, 6)).toEqual([
            String(peer.pid),
            String(peer.ppid),
            String(peer.pgid),
            String(peer.uid),
            peer.started,
            peer.owned ? "1" : "0",
          ]);
          expect(
            transition.stdout
              .trim()
              .split("\n")
              .filter((line) => line.startsWith(`${receipt.pid}\t`)).length,
          ).toBeLessThanOrEqual(1);
        }
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
      expect(
        await findProcessIdentities(invocation, [
          inspector.pid!,
          owned.pid!,
          inspector.pid!,
        ]),
      ).toEqual([inspectorIdentity, record.identity, inspectorIdentity]);

      await assertWatchdogInspectionFailureGroups(directory);

      const watchdogInvocation = await createInvocation(directory);
      let watchdog: ChildProcess | undefined;
      let watchdogReader: string | undefined;
      let restoreWatchdogEnvironmentRead: (() => Promise<void>) | undefined;

      try {
        const watchdogEnvironment =
          await fixtureProcessEnvironment(watchdogInvocation);
        const expectedOwner = JSON.parse(
          watchdogEnvironment.MAISTER_TEST_PROCESS_OWNER!,
        ) as { pid: number };
        const expectedParent = JSON.parse(
          watchdogEnvironment.MAISTER_TEST_PROCESS_PARENT!,
        ) as { pid: number };

        restoreWatchdogEnvironmentRead = await installEnvironmentReadDenial(
          watchdogInvocation,
          expectedOwner.pid,
          environmentDeniedExecutable,
        );
        // A module entry runs inherited --import preloads; classic eval workers skip them.
        const workerSource =
          'import { parentPort, threadId, isMainThread } from "node:worker_threads"; parentPort.on("message", () => {}); parentPort.postMessage({ threadId, isMainThread });';
        const watchdogSource = `const { Worker } = require("node:worker_threads"); const worker = new Worker(new URL(${JSON.stringify(`data:text/javascript,${encodeURIComponent(workerSource)}`)}), { execArgv: process.execArgv.slice(0, 4) }); worker.once("error", (error) => { throw error; }); worker.once("message", (identity) => process.stderr.write(JSON.stringify({ event: "inspection-control-ready", ...identity }) + "\\n"));`;
        const spawnedWatchdog = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            FIXTURE_WATCHDOG,
            "-e",
            watchdogSource,
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
        const watchdogRecord = await registerSpawnedProcess(
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
        const readyLine = watchdogOutput
          .split("\n")
          .find((line) => line.includes('"event":"inspection-control-ready"'));

        if (!readyLine)
          throw new Error(
            `watchdog worker readiness receipt is missing\n${watchdogOutput}`,
          );
        const workerIdentity = JSON.parse(readyLine) as {
          threadId: number;
          isMainThread: boolean;
        };
        const timingRecords = watchdogOutput
          .split("\n")
          .filter((line) =>
            line.includes('"event":"fixture-watchdog-lookup-timing"'),
          )
          .map((line) => ({
            line,
            timing: JSON.parse(line) as {
              invocationId: string;
              pid: number;
              pgid: number;
              kernelStartId: string;
              threadId: number;
              isMainThread: boolean;
              role: string;
              caseName: string;
              runtime: string;
              platform: string;
              arch: string;
              checks: number;
              selectedPids: number[];
              targetCount: number;
              cadenceMs: number;
              lookupMs: number;
              maxLookupMs: number;
              observedElapsedMs: number;
              overlapping: boolean;
              rightCensored: boolean;
            },
          }));
        const selectedPids = [
          ...new Set([expectedOwner.pid, expectedParent.pid]),
        ];

        expect(workerIdentity.threadId).toBeGreaterThan(0);
        expect(workerIdentity.isMainThread).toBe(false);
        for (const threadIdentity of [
          { threadId: 0, isMainThread: true },
          {
            threadId: workerIdentity.threadId,
            isMainThread: workerIdentity.isMainThread,
          },
        ]) {
          const firstRecord = timingRecords.find(
            ({ timing }) =>
              timing.threadId === threadIdentity.threadId &&
              timing.checks === 1,
          );

          expect(
            firstRecord,
            `first watchdog timing receipt for thread ${threadIdentity.threadId}\n${watchdogOutput}`,
          ).toBeDefined();
          if (!firstRecord)
            throw new Error("watchdog thread timing receipt is missing");
          const { timing, line } = firstRecord;

          expect(timing).toMatchObject({
            invocationId: watchdogInvocation.id,
            pid: spawnedWatchdog.pid,
            pgid: watchdogRecord.identity.pgid,
            kernelStartId: watchdogRecord.identity.started,
            ...threadIdentity,
            role: "fixture",
            caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture",
            runtime: process.version,
            platform: process.platform,
            arch: process.arch,
            checks: 1,
            selectedPids,
            targetCount: selectedPids.length,
            cadenceMs: 500,
            overlapping: true,
            rightCensored: true,
          });
          expect(Number.isFinite(timing.lookupMs)).toBe(true);
          expect(timing.lookupMs).toBeGreaterThan(0);
          expect(timing.maxLookupMs).toBe(timing.lookupMs);
          expect(timing.observedElapsedMs).toBeGreaterThanOrEqual(
            timing.lookupMs,
          );
          process.stderr.write(`${line}\n`);
        }
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
        if (restoreWatchdogEnvironmentRead)
          await restoreWatchdogEnvironmentRead();
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
