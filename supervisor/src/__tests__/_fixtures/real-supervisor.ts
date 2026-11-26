// The production boot as a child process: `supervisor/src/main.ts` under tsx,
// in its own process group. Session gates own separate groups, captured before
// an intentional supervisor kill and reclaimed through checked fixture ownership.
//
// The web lane has an equivalent (`web/test-support/real-supervisor.ts`) and
// this is deliberately NOT a re-export of it: that module is compiled under
// web's tsconfig (DOM lib), so importing it here drags a `RequestInit.cache`
// that the supervisor's Node-only lib does not have into this package's
// typecheck. The packages cannot share the module; they share the question.
import type { ChildProcess } from "node:child_process";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  retryFixturePortAllocation,
  startOwnedFixture,
} from "../../../../web/test-support/owned-fixture";
import { captureSupervisorProcessGroups } from "../../../../web/test-support/capture-supervisor-process-groups";
import {
  assertInvocationGroupEmpty,
  createInvocation,
  fixtureProcessEnvironment,
  invocationFromEnvironment,
  registerRoot,
  releaseInvocation,
  signalInvocationGroup,
} from "../../../../web/test-support/process-invocation";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_DIR = path.resolve(HERE, "../../..");
const SUPERVISOR_MAIN = path.join(SUPERVISOR_DIR, "src", "main.ts");
const FIXTURES_DIR = path.join(SUPERVISOR_DIR, "test", "fixtures");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

export type RealSupervisorOptions = {
  fixture?: string;
  fixtureArgs?: string[];
  env?: Record<string, string>;
};

export type RealSupervisor = {
  url: string;
  runtimeRoot: string;
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  stop(): Promise<void>;
  logTail(maxBytes?: number): Promise<string>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("no port"));

        return;
      }
      const { port } = address;

      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(
  url: string,
  exited: Promise<number | null>,
  timeoutMs: number,
  hostKey: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let gone = false;

  void exited.then(() => {
    gone = true;
  });
  while (Date.now() < deadline) {
    if (gone) throw new Error(`supervisor exited before /health (${url})`);
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2_000),
      });

      if (response.ok) {
        const health = (await response.json()) as {
          host?: { hostKey?: string; bootId?: string };
        };

        if (
          health.host?.hostKey === hostKey &&
          typeof health.host.bootId === "string"
        )
          return health.host.bootId;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`supervisor did not answer /health in ${timeoutMs}ms`);
}

async function writeAdapterWrapper(
  runtimeRoot: string,
  fixturePath: string,
  fixtureArgs: string[],
): Promise<string> {
  const wrapper = path.join(runtimeRoot, "bin", "claude-agent-acp");
  const quoted = fixtureArgs
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");

  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec '${process.execPath}' '${fixturePath}' ${quoted} "$@"\n`,
    { mode: 0o755 },
  );

  return wrapper;
}

export async function startRealSupervisor(
  options: RealSupervisorOptions = {},
): Promise<RealSupervisor> {
  return retryFixturePortAllocation(() => startRealSupervisorAttempt(options));
}

async function startRealSupervisorAttempt(
  options: RealSupervisorOptions,
): Promise<RealSupervisor> {
  const runtimeRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "sup-rt-")),
  );
  const inheritedInvocation = invocationFromEnvironment();
  const invocation =
    inheritedInvocation ??
    (await createInvocation(path.join(tmpdir(), "maister-process-ledgers")));

  await registerRoot(invocation, runtimeRoot, "supervisor");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logFile = path.join(runtimeRoot, "supervisor.log");
  const fixture = options.fixture ?? "mock-acp-lifecycle.mjs";
  const fixturePath = path.isAbsolute(fixture)
    ? fixture
    : path.join(FIXTURES_DIR, fixture);
  const hostKey = randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    MAISTER_SUPERVISOR_PORT: String(port),
    MAISTER_RUNTIME_ROOT: runtimeRoot,
    MAISTER_EXECUTION_HOST_STATE_DIR: path.join(
      runtimeRoot,
      ".maister",
      "execution-host",
    ),
    MAISTER_WORKSPACE_ROOTS: runtimeRoot,
    MAISTER_ADAPTER_BINARY_CLAUDE: await writeAdapterWrapper(
      runtimeRoot,
      fixturePath,
      options.fixtureArgs ?? [],
    ),
    MAISTER_HEARTBEAT_INTERVAL_MS: "1000",
    MAISTER_SHUTDOWN_GRACE_MS: "1000",
    MAISTER_KILL_GRACE_MS: "500",
    ...options.env,
    MAISTER_EXECUTION_HOST_KEY: hostKey,
    ...(await fixtureProcessEnvironment(invocation)),
  };

  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;

  const logFd = openSync(logFile, "a");
  // node runs main.ts with tsx registered as an import hook: pnpm's `.bin/tsx`
  // shim puts a proxy in front that never relays SIGKILL.
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", TSX_LOADER, SUPERVISOR_MAIN],
    {
      cwd: SUPERVISOR_DIR,
      env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    },
  );

  closeSync(logFd);

  const owned = await startOwnedFixture({
    invocation,
    child,
    role: "supervisor",
    root: runtimeRoot,
    logFile,
    bootId: `starting:${child.pid ?? -1}`,
    killGraceMs: 10_000,
    ready: (exited) => waitForHealth(url, exited, 60_000, hostKey),
  }).catch(async (error: unknown) => {
    if (!inheritedInvocation) {
      const failures = await releaseInvocation(
        invocation,
        "Supervisor startup",
      );

      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "Supervisor fixture cleanup failed",
        );
    }
    throw error;
  });
  const { pid, exited } = owned;
  const leaderGone = () => child.exitCode !== null || child.signalCode !== null;
  const sessionGroups = new Set<number>();
  let invocationReleased = false;

  const captureSessionGroups = async (): Promise<void> => {
    if (leaderGone()) return;
    const groups = await captureSupervisorProcessGroups({
      invocation,
      url,
      supervisorPid: pid,
      runtimeRoot,
      bootId: owned.bootId,
      logFile,
      caseName: "supervisor-session",
    });

    for (const group of groups) sessionGroups.add(group);
  };

  const kill = async (signal: NodeJS.Signals = "SIGKILL") => {
    const failures: unknown[] = [];

    try {
      await captureSessionGroups();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owned.kill(signal);
    } catch (error) {
      failures.push(error);
    }
    for (const group of sessionGroups) {
      try {
        await signalInvocationGroup(invocation, group, "SIGKILL");
        await assertInvocationGroupEmpty(invocation, group);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!inheritedInvocation && !invocationReleased) {
      invocationReleased = true;
      failures.push(
        ...(await releaseInvocation(invocation, "Supervisor fixture")),
      );
    }
    if (failures.length)
      throw new AggregateError(failures, "Supervisor fixture cleanup failed");
  };

  return {
    url,
    runtimeRoot,
    exited,
    kill,
    stop: () => kill("SIGTERM"),
    async logTail(maxBytes = 16 * 1024) {
      try {
        return (await readFile(logFile, "utf8")).slice(-maxBytes);
      } catch (err) {
        return `<log unreadable: ${err instanceof Error ? err.message : String(err)}>`;
      }
    },
  };
}
