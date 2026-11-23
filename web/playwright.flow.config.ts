import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

const authed = base.projects?.find((project) => project.name === "authed");

if (!authed)
  throw new Error(
    "Flow browser qualification requires the authenticated Run fixture",
  );

const flowControls = {
  ...authed,
  testMatch: /(?:m22-workbench|m15-readiness|child-run-peek)\.spec\.ts$/,
  grep: /@flow-controls\b/,
};

export default defineConfig({
  ...base,
  projects: [
    ...(base.projects ?? []),
    { ...flowControls, name: "flow-chromium" },
    {
      ...flowControls,
      name: "flow-firefox",
      use: { ...authed.use, ...devices["Desktop Firefox"] },
    },
  ],
});
