import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { E2E_DB_URL } from "./e2e/_seed/db-url";

const WEB_PORT = Number(process.env.E2E_LIVE_WEB_PORT ?? 3101);
const SUPERVISOR_PORT = Number(process.env.MAISTER_SUPERVISOR_PORT ?? 7777);
const BASE_URL =
  process.env.E2E_LIVE_BASE_URL ?? `http://localhost:${WEB_PORT}`;
const SUPERVISOR_URL = `http://127.0.0.1:${SUPERVISOR_PORT}`;
const AUTH_SECRET =
  process.env.AUTH_SECRET ?? "e2e-insecure-test-secret-change-me";
const ccrEnv = {
  ...(process.env.MAISTER_CCR_CONFIG_PATH
    ? { MAISTER_CCR_CONFIG_PATH: process.env.MAISTER_CCR_CONFIG_PATH }
    : {}),
  ...(process.env.MAISTER_CCR_AUTH_TOKEN
    ? { MAISTER_CCR_AUTH_TOKEN: process.env.MAISTER_CCR_AUTH_TOKEN }
    : {}),
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts$/ },
    {
      name: "live-supervisor",
      dependencies: ["setup"],
      testMatch: /live-supervisor-ccr\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/admin.json",
      },
    },
  ],
  webServer: [
    {
      command: `pnpm --dir .. --filter @maister/supervisor dev`,
      url: `${SUPERVISOR_URL}/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        MAISTER_SUPERVISOR_PORT: String(SUPERVISOR_PORT),
        MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime-live-supervisor"),
        ...ccrEnv,
      },
    },
    {
      command: `pnpm exec next dev -p ${WEB_PORT}`,
      url: BASE_URL,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        DB_URL: E2E_DB_URL,
        AUTH_SECRET,
        MAISTER_RUNTIME_ROOT: path.resolve("e2e/.runtime-live-web"),
        MAISTER_SUPERVISOR_URL: SUPERVISOR_URL,
      },
    },
  ],
});
