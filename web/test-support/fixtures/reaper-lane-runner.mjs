import { runStageAbLane } from "../../../scripts/run-stage-ab-tests.mjs";

import { invocationFromEnvironment } from "../process-invocation.ts";

const invocation = invocationFromEnvironment();

if (!invocation)
  throw new Error("nested reaper runner requires its parent-minted invocation");

const result = await runStageAbLane({
  slice: "isolation",
  files: ["test-support/__tests__/execution-ab-reaper.integration.test.ts"],
  owningInvocation: invocation,
});

if (!process.send) throw new Error("nested reaper control requires IPC");
await new Promise((resolve, reject) => {
  process.send(
    { event: "completed", reportPath: result.reportPath },
    (error) => {
      if (error) reject(error);
      else resolve();
    },
  );
});
process.disconnect();
