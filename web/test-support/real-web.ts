import type { IsolationDriver } from "./process-isolation";

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { freePort } from "./real-supervisor";
import {
  FIXTURE_WATCHDOG,
  fixtureProcessEnvironment,
  invocationFromEnvironment,
  registerProcess,
  registerSpawnedProcess,
  findProcessIdentity,
  processIdentity,
  sameProcess,
  readLogTail,
  fixtureLogTail,
  preserveFixtureLog,
  signalInvocationGroup,
  assertInvocationGroupEmpty,
  logInvocation,
} from "./process-invocation";

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
const LOG_TAIL_BYTES = 16 * 1024;

export type RealWebOptions = {
  build?: ProductionWebBuild;
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

// `web/.next` is ONE directory shared by every suite that builds a production
// web, and the integration project runs files in parallel — so two concurrent
// `next build`s would write the same output tree and serve each other's halves.
// An atomic symlink to a complete owner identity serializes builds. Only a
// proved dead owner can be reclaimed; elapsed age never grants that authority.
const BUILD_LOCK_DIR = path.join(WEB_DIR, ".next.build-lock");
const BUILD_LOCK_POLL_MS = 500;
const execFileAsync = promisify(execFile);

export type ProductionWebBuild = Readonly<{
  revision: string;
  buildId: string;
  artifactPath: string;
  invocationId: string;
}>;

async function currentRevision(): Promise<string> {
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: WEB_DIR })
  ).stdout.trim();
}

async function acquireBuildLock(): Promise<() => Promise<void>> {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("production build requires a test invocation");
  const identity = await processIdentity(invocation, process.pid);
  const ownerFile = path.join(
    invocation.directory,
    `build-lock-${randomUUID()}.json`,
  );

  // Publish the complete identity before atomically installing its symlink.
  // A death between allocation and publication cannot create an ownerless lock.
  await writeFile(ownerFile, JSON.stringify(identity), {
    flag: "wx",
    mode: 0o600,
  });
  const deadline = Date.now() + 20 * 60 * 1000;

  while (Date.now() < deadline) {
    try {
      await symlink(ownerFile, BUILD_LOCK_DIR);

      return async () => {
        if ((await readlink(BUILD_LOCK_DIR)) !== ownerFile)
          throw new Error("build lock owner changed before release");
        await unlink(BUILD_LOCK_DIR);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const target = await readlink(BUILD_LOCK_DIR);
        const owner = JSON.parse(
          await readFile(BUILD_LOCK_DIR, "utf8"),
        ) as typeof identity;
        const current = await findProcessIdentity(invocation, owner.pid);

        if (!current || !sameProcess(owner, current)) {
          if ((await readlink(BUILD_LOCK_DIR)) === target)
            await unlink(BUILD_LOCK_DIR);
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, BUILD_LOCK_POLL_MS),
          );
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT")
          throw inspectionError;
        // Another contender released the same lock. Retry acquisition.
      }
    }
  }
  throw new Error(
    "production build lock did not become available within 20 minutes",
  );
}

// Exactly ONE build per test-runner invocation, recorded inside the output tree
// it produced.
//
// `web/.next` is a single shared directory. Serializing the builds is not
// enough: a LATER build rewrites the tree a suite is already serving from, and
// that web dies mid-request — observed as `real web exited before /login
// answered` in two suites at once. Every caller in a run builds the same tree
// from the same revision, so the first one builds and the rest reuse it.
//
// The invocation id is the vitest run's own (`vitest.workspace.ts` mints it
// once and passes it to every worker), so a new run always rebuilds and a
// stale tree is never served.
const BUILD_STAMP_FILE = path.join(WEB_DIR, ".next", ".maister-lane-build");

function laneBuildId(): string {
  return process.env.MAISTER_TEST_WORKTREE_INVOCATION_ID ?? "no-invocation";
}

// `next build` of the checked-out tree: the harness never serves a build it
// did not make, so the evidence always belongs to the revision under test.
export async function buildProductionWeb(logFile: string): Promise<string> {
  const releaseBuildLock = await acquireBuildLock();

  try {
    const stamp = await readFile(BUILD_STAMP_FILE, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;

        return "";
      },
    );
    const revision = await currentRevision();

    if (stamp.startsWith("{")) {
      const build = JSON.parse(stamp) as ProductionWebBuild;

      if (build.invocationId === laneBuildId() && build.revision === revision) {
        await verifyProductionWebBuild(build);

        return build.buildId;
      }
    }
    const buildId = await runNextBuild(logFile);
    const build: ProductionWebBuild = {
      revision,
      buildId,
      artifactPath: path.dirname(BUILD_ID_FILE),
      invocationId: laneBuildId(),
    };

    await writeFile(BUILD_STAMP_FILE, JSON.stringify(build), "utf8");

    return buildId;
  } finally {
    await releaseBuildLock();
  }
}

export async function productionWebBuild(): Promise<ProductionWebBuild> {
  const build = JSON.parse(
    await readFile(BUILD_STAMP_FILE, "utf8"),
  ) as ProductionWebBuild;

  if (build.invocationId !== laneBuildId())
    throw new Error("production build belongs to a different invocation");
  await verifyProductionWebBuild(build);

  return build;
}

async function verifyProductionWebBuild(
  build: ProductionWebBuild,
): Promise<void> {
  const stamp = JSON.parse(
    await readFile(BUILD_STAMP_FILE, "utf8"),
  ) as ProductionWebBuild;
  const actualId = (await readFile(BUILD_ID_FILE, "utf8")).trim();

  if (
    build.artifactPath !== path.dirname(BUILD_ID_FILE) ||
    build.revision !== (await currentRevision()) ||
    !build.buildId ||
    build.buildId !== actualId ||
    JSON.stringify(stamp) !== JSON.stringify(build)
  )
    throw new Error(
      "production build handle no longer matches its revision and artifact",
    );
}

async function runNextBuild(logFile: string): Promise<string> {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("production build requires a test invocation");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(await fixtureProcessEnvironment(invocation)),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const logFd = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [
      "--import",
      FIXTURE_WATCHDOG,
      createRequire(import.meta.url).resolve("next/dist/bin/next"),
      "build",
    ],
    {
      cwd: WEB_DIR,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );

  closeSync(logFd);
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  await registerProcess(
    invocation,
    {
      role: "build",
      caseName: "production-build",
      rootRole: "artifact",
      root: null,
      bootId: invocation.id,
      logFile,
    },
    child.pid ?? -1,
  );
  const code = await exit;

  if (code !== 0)
    throw new Error(
      `next build exited ${code}; see ${logFile}\n${await readLogTail(logFile)}`,
    );

  return (await readFile(BUILD_ID_FILE, "utf8")).trim();
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
      const res = await fetch(`${url}/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });

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
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("real web fixture requires a test invocation");
  const build = options.build ?? (await productionWebBuild());

  await verifyProductionWebBuild(build);
  const buildId = build.buildId;
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const logFile =
    options.logFile ??
    path.join(invocation.directory, `web-${randomUUID().slice(0, 8)}.log`);
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
    ...(await fixtureProcessEnvironment(invocation)),
  };

  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const command = [
    process.execPath,
    "--import",
    FIXTURE_WATCHDOG,
    "--import",
    TSX_LOADER,
    SERVER_ENTRY,
  ];
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

  closeSync(logFd);
  const pid = child.pid ?? -1;
  const fixtureBootId = `${buildId}:${pid}`;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const leaderGone = () => child.exitCode !== null || child.signalCode !== null;

  try {
    await registerSpawnedProcess(
      invocation,
      {
        role: "web",
        caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture",
        rootRole: "web",
        root: options.runtimeRoot,
        bootId: fixtureBootId,
        logFile,
      },
      child,
    );
    await waitForLogin(url, options.startTimeoutMs ?? 120_000, exited);
  } catch (error) {
    const failures: unknown[] = [error];

    try {
      if (pid > 0) await signalInvocationGroup(invocation, pid, "SIGKILL");
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new Error(`web startup failed\n${await readLogTail(logFile)}`, {
      cause: new AggregateError(failures, "web startup/cleanup"),
    });
  }
  const kill = async (signal: NodeJS.Signals = "SIGKILL") => {
    if (!leaderGone()) {
      await signalInvocationGroup(invocation, pid, signal);
      await Promise.race([
        exited,
        new Promise<void>((r) => {
          setTimeout(r, 30_000).unref();
        }),
      ]);
      if (!leaderGone()) {
        await signalInvocationGroup(invocation, pid, "SIGKILL");
        await exited;
      }
    }
    try {
      await assertInvocationGroupEmpty(invocation, pid);
    } finally {
      await preserveFixtureLog(invocation, logFile);
    }
    logInvocation(
      invocation,
      signal === "SIGKILL" ? "fixture-kill" : "fixture-stop",
      {
        role: "web",
        caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture",
        pid,
        pgid: pid,
        rootRole: "web",
        bootId: fixtureBootId,
        signal,
        outcome: "stopped",
      },
    );
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
        return await fixtureLogTail(invocation, logFile, maxBytes);
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
