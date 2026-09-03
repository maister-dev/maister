import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ADR-165 T3.1: a REAL supervisor child for web integration tests — the
// production `supervisor/src/main.ts` boot (host state store, fences,
// receipts, adoption roots) with the mock ACP adapter fixture wired through
// the adapter registry's own override env. Tests point the local-direct
// transport at it via `MAISTER_SUPERVISOR_URL`.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");
const SUPERVISOR_DIR = path.join(REPO_DIR, "supervisor");
const SUPERVISOR_MAIN = path.join(SUPERVISOR_DIR, "src", "main.ts");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const FIXTURES_DIR = path.join(SUPERVISOR_DIR, "test", "fixtures");

export const DEFAULT_FIXTURE = "mock-acp-lifecycle.mjs";

export type RealSupervisorOptions = {
  runtimeRoot?: string;
  stateDir?: string;
  workspaceRoots?: string[];
  fixture?: string;
  fixtureArgs?: string[];
  port?: number;
  env?: Record<string, string>;
  logFile?: string;
  startTimeoutMs?: number;
};

export type RealSupervisor = {
  url: string;
  port: number;
  pid: number;
  runtimeRoot: string;
  stateDir: string;
  workspaceRoots: string[];
  logFile: string;
  options: RealSupervisorOptions;
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  stop(): Promise<void>;
  // Same runtime root, state dir, port and adapter fixture — the "restart on
  // the same state dir" of D8. `overrides` can swap the fixture args.
  restart(overrides?: Partial<RealSupervisorOptions>): Promise<RealSupervisor>;
};

export async function freePort(): Promise<number> {
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

async function writeAdapterWrapper(
  runtimeRoot: string,
  fixture: string,
  fixtureArgs: string[],
): Promise<string> {
  const binDir = path.join(runtimeRoot, "bin");
  const wrapper = path.join(binDir, "claude-agent-acp");
  const fixturePath = path.isAbsolute(fixture)
    ? fixture
    : path.join(FIXTURES_DIR, fixture);
  const quoted = fixtureArgs
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");

  await mkdir(binDir, { recursive: true });
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec '${process.execPath}' '${fixturePath}' ${quoted} "$@"\n`,
    { mode: 0o755 },
  );

  return wrapper;
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  exited: Promise<number | null>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let done = false;

  void exited.then(() => {
    done = true;
  });
  while (Date.now() < deadline) {
    if (done)
      throw new Error(
        `real supervisor exited before /health answered (${url})`,
      );
    try {
      const res = await fetch(`${url}/health`, { cache: "no-store" });

      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `real supervisor did not answer /health within ${timeoutMs} ms (${url})`,
  );
}

export async function startRealSupervisor(
  options: RealSupervisorOptions = {},
): Promise<RealSupervisor> {
  const runtimeRoot =
    options.runtimeRoot ??
    (await realpath(await mkdtemp(path.join(tmpdir(), "eh-web-rt-"))));
  const stateDir =
    options.stateDir ?? path.join(runtimeRoot, ".maister", "execution-host");
  const workspaceRoots = options.workspaceRoots ?? [runtimeRoot];
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const logFile =
    options.logFile ??
    path.join(runtimeRoot, `supervisor-${randomUUID().slice(0, 8)}.log`);
  const wrapper = await writeAdapterWrapper(
    runtimeRoot,
    options.fixture ?? DEFAULT_FIXTURE,
    options.fixtureArgs ?? [],
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    MAISTER_SUPERVISOR_PORT: String(port),
    MAISTER_RUNTIME_ROOT: runtimeRoot,
    MAISTER_EXECUTION_HOST_STATE_DIR: stateDir,
    MAISTER_WORKSPACE_ROOTS: workspaceRoots.join(path.delimiter),
    MAISTER_ADAPTER_BINARY_CLAUDE: wrapper,
    MAISTER_HEARTBEAT_INTERVAL_MS: "1000",
    MAISTER_SHUTDOWN_GRACE_MS: "1000",
    MAISTER_KILL_GRACE_MS: "500",
    ...options.env,
  };

  // The child must not inherit the vitest marker: `main.ts` only boots when
  // it is absent.
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;

  const logFd = openSync(logFile, "a");
  // The supervisor MUST be the direct child: pnpm's `.bin/tsx` shim and the
  // tsx CLI both put a proxy process in front (SIGKILL is never relayed), so
  // node runs `main.ts` itself with tsx registered as an import hook.
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", TSX_LOADER, SUPERVISOR_MAIN],
    {
      cwd: SUPERVISOR_DIR,
      env,
      stdio: ["ignore", logFd, logFd],
    },
  );
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  try {
    await waitForHealth(url, options.startTimeoutMs ?? 60_000, exited);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }

  const kill = async (signal: NodeJS.Signals = "SIGKILL") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await Promise.race([
      exited,
      new Promise<void>((r) => setTimeout(r, 10_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };

  const handle: RealSupervisor = {
    url,
    port,
    pid: child.pid ?? -1,
    runtimeRoot,
    stateDir,
    workspaceRoots,
    logFile,
    options: { ...options, runtimeRoot, stateDir, workspaceRoots, port },
    exited,
    kill,
    stop: () => kill("SIGTERM"),
    restart: async (overrides = {}) => {
      await kill("SIGKILL");
      // The kernel may hold the port briefly after a SIGKILL — retry the bind.
      let last: unknown;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          return await startRealSupervisor({
            ...handle.options,
            ...overrides,
            logFile,
          });
        } catch (err) {
          last = err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      throw last;
    },
  };

  return handle;
}

export function useRealSupervisorUrl(url: string): () => void {
  const previous = process.env.MAISTER_SUPERVISOR_URL;

  process.env.MAISTER_SUPERVISOR_URL = url;

  return () => {
    if (previous === undefined) delete process.env.MAISTER_SUPERVISOR_URL;
    else process.env.MAISTER_SUPERVISOR_URL = previous;
  };
}
