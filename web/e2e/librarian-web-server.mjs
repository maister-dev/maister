import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";

const webPort = Number(process.env.E2E_LIBRARIAN_WEB_PORT ?? 3103);
const controlPort = Number(process.env.E2E_LIBRARIAN_WEB_CONTROL_PORT ?? 3104);
let child;
let stopping = false;
let restarting = false;

function startWeb() {
  child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(webPort) },
    stdio: "inherit",
  });
  child.once("exit", (code) => {
    if (!stopping && !restarting) process.exit(code ?? 1);
  });
}

async function stopWeb() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closing = once(child, "exit");

  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, 5_000);

  try {
    await closing;
  } finally {
    clearTimeout(timeout);
  }
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${webPort}/login`, {
        signal: AbortSignal.timeout(500),
      });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`librarian web server did not stop on port ${webPort}`);
}

async function waitForWeb() {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/login`, {
        signal: AbortSignal.timeout(3_000),
      });

      if (response.ok) return;
    } catch {
      // The replacement process is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`librarian web server did not restart on port ${webPort}`);
}

const control = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/restart") {
    response.writeHead(404).end();

    return;
  }
  if (request.headers["x-maister-e2e-control"] !== "librarian-e2e-control") {
    response.writeHead(403).end();

    return;
  }
  if (restarting) {
    response.writeHead(409).end();

    return;
  }
  restarting = true;
  try {
    await stopWeb();
    startWeb();
    await waitForWeb();
    response.writeHead(200).end("ready");
  } catch (error) {
    response.writeHead(500).end(String(error));
  } finally {
    restarting = false;
  }
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  control.close();
  await stopWeb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
control.listen(controlPort, "127.0.0.1");
execFileSync("pnpm", ["run", "clean"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [path.resolve("node_modules/next/dist/bin/next"), "build", "--webpack"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);
startWeb();
