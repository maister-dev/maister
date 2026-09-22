import { it } from "vitest";

import { startReadyRealFixtureStack } from "./process-cleanup-stack";

it("stops a real production stack normally", async () => {
  const stack = await startReadyRealFixtureStack();

  await stack.web.stop();
  await stack.supervisor.stop();
  await stack.database.stop();
});
