// Opt-in live ACP qualification. Each invocation uses the same seeded
// Playwright lane and scenario ids as the mock acceptance suite.
import { spawnSync } from "node:child_process";
import path from "node:path";

const scenarios = ["L-01", "L-02", "L-03", "L-04", "L-08", "L-12", "D5"];
const args = process.argv.slice(2);
const adapterIndex = args.indexOf("--adapter");
const adapter = adapterIndex >= 0 ? args[adapterIndex + 1] : undefined;
const grepIndex = args.indexOf("--grep");
const grep = grepIndex >= 0 ? args[grepIndex + 1] : undefined;

if (adapter !== "claude" && adapter !== "codex")
  throw new Error(
    "usage: node scripts/qualify-librarian.mjs --adapter claude|codex [--grep QL-L-01]",
  );
if (grep && !scenarios.some((scenario) => grep.includes(scenario)))
  throw new Error(
    `qualification grep must name one of ${scenarios.join(", ")}`,
  );

const startedAt = new Date().toISOString();
const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "maister-web",
    "test:e2e",
    "--config",
    "playwright.librarian.config.ts",
    ...(grep ? ["--grep", grep] : []),
  ],
  {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      MAISTER_LIBRARIAN_QUALIFY_ADAPTER: adapter,
      TESTCONTAINERS_RYUK_DISABLED:
        process.env.TESTCONTAINERS_RYUK_DISABLED ?? "true",
    },
    stdio: "inherit",
  },
);

console.log(
  JSON.stringify({
    adapter,
    scenarios: grep
      ? scenarios.filter((scenario) => grep.includes(scenario))
      : scenarios,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal,
  }),
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
