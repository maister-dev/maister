import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

const setup = base.projects?.find(({ name }) => name === "setup");
const authed = base.projects?.find(({ name }) => name === "authed");

if (!setup || !authed)
  throw new Error(
    "Knowledge qualification requires the seeded Playwright login project",
  );

export default defineConfig({
  ...base,
  workers: 1,
  projects: [
    setup,
    {
      ...authed,
      name: "knowledge-firefox",
      testMatch: /(?:inbox|company-brain)\.spec\.ts$/,
      use: { ...authed.use, ...devices["Desktop Firefox"] },
    },
  ],
});
