import { execFileSync } from "node:child_process";

/**
 * Prepares the isolated E2E database before Next.js is allowed to boot.
 * Playwright starts `webServer` before `globalSetup`; keeping this outside
 * global setup lets the production migration guard observe an applied ledger.
 */
export async function prepareE2eDatabase(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...environment,
    DB_URL: databaseUrl,
    NODE_ENV: "test",
  };

  execFileSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--import",
      "./scripts/_register-shim.mjs",
      "lib/db/migrate.ts",
    ],
    { stdio: "inherit", env },
  );
  execFileSync("pnpm", ["exec", "tsx", "lib/db/migrate-brain.ts"], {
    stdio: "inherit",
    env,
  });
  execFileSync("pnpm", ["exec", "tsx", "e2e/_seed/seed-e2e.ts"], {
    stdio: "inherit",
    env,
  });
}
