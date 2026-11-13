import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { it } from "vitest";

const execFileAsync = promisify(execFile);

it("bounds Flight debug ancestry and preserves worker shutdown and failures", async () => {
  await execFileAsync(
    process.execPath,
    [
      "--expose-gc",
      "--max-old-space-size=256",
      "--conditions=react-server",
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/loop-memory.ts", import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, NODE_ENV: "development" },
      timeout: 30_000,
    },
  );
});
