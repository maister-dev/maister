import path from "node:path";

import { resolvePostgresDbUrl } from "../lib/db/postgres-url";
import { invocationFromEnvironment } from "../test-support/process-invocation";
import { buildProductionWeb, startRealWeb } from "../test-support/real-web";

const invocation = invocationFromEnvironment();
const port = Number(process.env.PORT);
const runtimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const supervisorUrl = process.env.MAISTER_SUPERVISOR_URL;

if (!invocation)
  throw new Error("E2E web server requires an owning invocation");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new RangeError(
    "E2E web server PORT must be an integer from 1 to 65535",
  );
if (!runtimeRoot || !worktreesRoot || !supervisorUrl)
  throw new Error(
    "E2E web server requires runtime/worktree roots and supervisor URL",
  );

// Compile once before Chromium starts; route visits must not grow a dev compiler.
await buildProductionWeb(path.join(invocation.directory, "e2e-next-build.log"));
let web = await startRealWeb({
  port,
  databaseUrl: resolvePostgresDbUrl(),
  runtimeRoot,
  worktreesRoot,
  supervisorUrl,
  authSecret: process.env.AUTH_SECRET,
  env: {
    HOME: path.join(worktreesRoot, ".fixture-home"),
  ...(process.env.MAISTER_E2E_CATALOG_FIXTURE === "1" && {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--import=${new URL("./_seed/catalog-upstream.mjs", import.meta.url).href}`,
      ]
        .filter(Boolean)
        .join(" "),
      MAISTER_STUDIO_CATALOG_REPOS: JSON.stringify([
        { id: "fixture-skills", repo: "fixture/catalog-skills", kind: "skill" },
      ]),
  }),
  },
  logFile: path.join(invocation.directory, "e2e-web.log"),
});
let requestShutdown: () => void = () => {};
const shutdown = new Promise<void>((resolve) => {
  requestShutdown = () => resolve();
});

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
let restartOnKill = process.env.E2E_STAND_RESTART_WEB_ON_SIGKILL === "1";

try {
  for (;;) {
    const result = await Promise.race([shutdown, web.outcome]);

    if (!result) break;
    if (
      restartOnKill &&
      result.kind === "observed" &&
      result.signal === "SIGKILL"
    ) {
      restartOnKill = false;
      web = await web.restart();
      continue;
    }
    throw new Error(
      `E2E web server exited unexpectedly (${JSON.stringify(result)})\n${await web.logTail()}`,
    );
  }
} finally {
  await web.stop();
  process.off("SIGINT", requestShutdown);
  process.off("SIGTERM", requestShutdown);
}
