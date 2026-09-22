import childProcess from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { runStageAbLane } from "../../../scripts/run-stage-ab-tests.mjs";

const reportFaults = {
  missing: (filename) => unlinkSync(filename),
  invalid: (filename) => writeFileSync(filename, "{invalid JSON"),
};
const fault = reportFaults[process.argv[3]];

if (process.argv[3] && !fault) throw new Error("unknown private reporter fault");
if (fault) {
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = (file, args, options) => {
    const child = originalSpawn(file, args, options);
    const output = args.find((argument) => argument.startsWith("--outputFile="));

    // Alter the real reporter artifact after Vitest closes, before its runner
    // reads it. Only this private control can install the mutation.
    if (output) child.prependOnceListener("exit", () => fault(output.slice("--outputFile=".length)));
    return child;
  };
  syncBuiltinESMExports();
}

await runStageAbLane({
  slice: "isolation",
  files: [process.argv[2]],
  workspace: "test-support/fixtures/process-cleanup.workspace.ts",
});
