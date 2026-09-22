import { defineWorkspace } from "vitest/config";

import workspace from "../../vitest.workspace";

const integration = workspace[1];

if (
  typeof integration !== "object" ||
  integration === null ||
  !("test" in integration)
) {
  throw new Error("cleanup control requires the existing integration project");
}

export default defineWorkspace([
  {
    ...integration,
    test: {
      ...integration.test,
      include: ["test-support/fixtures/process-cleanup-*.case.ts"],
      testTimeout: 600_000,
    },
  },
]);
