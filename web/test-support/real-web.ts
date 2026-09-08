import type { IsolationDriver } from "./process-isolation";

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { freePort } from "./real-supervisor";

// AT-16 (D10): a REAL production web process for integration tests — the
// `server.ts` entrypoint the systemd unit and the image run (`next build`
// output, `instrumentation.ts` boot, lifecycle drain), on its own port,
// database and runtime root, optionally wrapped in a filesystem isolation
// driver so the host's private roots are unreachable from its identity.
//
// Like the real supervisor it leads its own process group so `kill()` reaches
// everything it spawned and asserts nothing survives.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..");
const SERVER_ENTRY = path.join(WEB_DIR, "server.ts");
const BUILD_ID_FILE = path.join(WEB_DIR, ".next", "BUILD_ID");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const ORPHAN_GRACE_MS = 3_000;
const LOG_TAIL_BYTES = 16 * 1024;

export type RealWebOptions = {
  databaseUrl: string;
  supervisorUrl: string;
  runtimeRoot: string;
  worktreesRoot: string;
  port?: number;
  authSecret?: string;
  isolation?: { driver: IsolationDriver; deniedRoots: readonly string[] };
  env?: Record<string, string>;
  logFile?: string;
  startTimeoutMs?: number;
};

export type RealWeb = {
  url: string;
  port: number;
  pid: number;
  buildId: string;
  logFile: string;
  options: RealWebOptions;
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  stop(): Promise<void>;
  logTail(maxBytes?: number): Promise<string>;
  // Same port, roots, database and isolation — the restart of a production
  // web on its persisted state.
  restart(overrides?: Partial<RealWebOptions>): Promise<RealWeb>;
};

// `next build` of the checked-out tree: the harness never serves a build it
// did not make, so the evidence always belongs to the revision under test.
export async function buildProductionWeb(logFile: string): Promise<string> {
  const logFd = openSync(logFile, "a");
  // The build must not inherit the test runner's environment: Vitest sets
  // NODE_ENV=test and its worker markers, which change what Next builds.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const exit = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "next", "build"], {
      cwd: WEB_DIR,
      env,
      stdio: ["ignore", logFd, logFd],
    });

    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  if (exit !== 0) {
    const tail = (await readFile(logFile, "utf8").catch(() => "")).slice(
      -LOG_TAIL_BYTES,
    );

    throw new Error(`next build exited ${exit}; see ${logFile}\n${tail}`);
  }

  return (await readFile(BUILD_ID_FILE, "utf8")).trim();
}

function groupMembers(pgid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-g", String(pgid)], (err, stdout) => {
      if (err) {
        resolve([]);

        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isFinite(pid)),
      );
    });
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

async function assertGroupEmpty(pgid: number): Promise<void> {
  const deadline = Date.now() + ORPHAN_GRACE_MS;
  let survivors = await groupMembers(pgid);

  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    survivors = await groupMembers(pgid);
  }
  if (survivors.length === 0) return;
  signalGroup(pgid, "SIGKILL");
  throw new Error(
    `real web (pgid ${pgid}) left orphaned processes after kill: ${survivors.join(", ")} — SIGKILLed`,
  );
}

async function waitForLogin(
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
      throw new Error(`real web exited before /login answered (${url})`);
    try {
      // `server.ts` listens only after `instrumentation.ts` finished booting,
      // so a served page means the production initialization completed.
      const res = await fetch(`${url}/login`, { redirect: "manual" });

      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `real web did not answer /login within ${timeoutMs} ms (${url})`,
  );
}

export async function startRealWeb(options: RealWebOptions): Promise<RealWeb> {
  const buildId = (
    await readFile(BUILD_ID_FILE, "utf8").catch(() => "")
  ).trim();

  if (!buildId) {
    throw new Error(
      "no production build under web/.next — call buildProductionWeb() first",
    );
  }
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const logFile =
    options.logFile ??
    path.join(options.runtimeRoot, `web-${randomUUID().slice(0, 8)}.log`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    LOG_LEVEL: "info",
    PORT: String(port),
    DB_URL: options.databaseUrl,
    AUTH_SECRET: options.authSecret ?? "isolation-insecure-test-secret",
    MAISTER_RUNTIME_ROOT: options.runtimeRoot,
    MAISTER_WORKTREES_ROOT: options.worktreesRoot,
    MAISTER_SUPERVISOR_URL: options.supervisorUrl,
    MAISTER_API_BASE_URL: url,
    ...options.env,
  };

  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const command = [process.execPath, "--import", TSX_LOADER, SERVER_ENTRY];
  const wrapped = options.isolation
    ? options.isolation.driver.wrap(command, options.isolation.deniedRoots)
    : { file: command[0], args: command.slice(1) };
  const logFd = openSync(logFile, "a");
  const child: ChildProcess = spawn(wrapped.file, wrapped.args, {
    cwd: WEB_DIR,
    env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  const pid = child.pid ?? -1;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const leaderGone = () => child.exitCode !== null || child.signalCode !== null;

  try {
    await waitForLogin(url, options.startTimeoutMs ?? 120_000, exited);
  } catch (err) {
    if (pid > 0) signalGroup(pid, "SIGKILL");
    const tail = (await readFile(logFile, "utf8").catch(() => "")).slice(
      -LOG_TAIL_BYTES,
    );

    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${tail}`,
    );
  }
  const kill = async (signal: NodeJS.Signals = "SIGKILL") => {
    if (!leaderGone()) {
      signalGroup(pid, signal);
      await Promise.race([
        exited,
        new Promise<void>((r) => setTimeout(r, 30_000)),
      ]);
      if (!leaderGone()) {
        signalGroup(pid, "SIGKILL");
        await exited;
      }
    }
    await assertGroupEmpty(pid);
  };
  const handle: RealWeb = {
    url,
    port,
    pid,
    buildId,
    logFile,
    options: { ...options, port },
    exited,
    kill,
    stop: () => kill("SIGTERM"),
    async logTail(maxBytes = LOG_TAIL_BYTES) {
      try {
        return (await readFile(logFile, "utf8")).slice(-maxBytes);
      } catch (err) {
        return `<log unreadable: ${err instanceof Error ? err.message : String(err)}>`;
      }
    },
    restart: async (overrides = {}) => {
      await kill("SIGKILL");
      let last: unknown;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          return await startRealWeb({
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

// A credentials sign-in over the production HTTP surface (Auth.js CSRF +
// callback), returning the cookie header an authenticated client sends.
export async function signInWithCredentials(
  url: string,
  credentials: { email: string; password: string },
): Promise<string> {
  const jar = new Map<string, string>();
  const absorb = (res: Response) => {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");

      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const cookieHeader = () =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const csrf = await fetch(`${url}/api/auth/csrf`);

  absorb(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const callback = await fetch(`${url}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(),
    },
    body: new URLSearchParams({
      csrfToken,
      email: credentials.email,
      password: credentials.password,
    }),
  });

  absorb(callback);
  if (![200, 302].includes(callback.status)) {
    throw new Error(`credentials callback answered ${callback.status}`);
  }
  if (![...jar.keys()].some((name) => name.includes("session-token"))) {
    throw new Error("credentials sign-in did not establish a session cookie");
  }

  return cookieHeader();
}
