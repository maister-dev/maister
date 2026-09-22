import { expect, it } from "vitest";

import { startReadyRealFixtureStack } from "./process-cleanup-stack";

it("reports the intentional cleanup assertion failure", async () => {
  const stack = await startReadyRealFixtureStack();

  try {
    expect(stack.web.pid, "intentional cleanup assertion failure").toBe(-1);
  } finally {
    await stack.web.stop();
    await stack.supervisor.stop();
    await stack.database.stop();
  }
});
