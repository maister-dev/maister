import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

const authed = base.projects?.find((project) => project.name === "authed");

if (!authed)
  throw new Error(
    "Flow browser qualification requires the authenticated Run fixture",
  );

export default defineConfig({
  ...base,
  projects: [
    ...(base.projects ?? []),
    {
      ...authed,
      name: "flow-firefox",
      testMatch: /(?:m22-workbench|child-run-peek)\.spec\.ts$/,
      grep: /expands the live canvas|parent fullscreen/,
      use: { ...authed.use, ...devices["Desktop Firefox"] },
    },
  ],
});
