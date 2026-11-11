import { runStageAbLane } from "./run-stage-ab-tests.mjs";

// Exercise native HTTP/streams, transaction ownership and a real production boot.
await runStageAbLane({
  slice: "web",
  files: [
    "lib/execution-host/__tests__/registrar.integration.test.ts",
    "lib/execution-host/events/__tests__/consumer-batching.integration.test.ts",
    "lib/scheduler/__tests__/clock-boot.integration.test.ts",
    "test-support/__tests__/real-supervisor.integration.test.ts",
  ],
});
