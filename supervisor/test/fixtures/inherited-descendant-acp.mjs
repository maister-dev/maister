import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

const pidFile = process.env.MAISTER_DESCENDANT_PID_FILE;
if (!pidFile)
  throw new Error("The owned descendant fixture requires its PID file");
const descendant = spawn(
  process.execPath,
  ["-e", "setTimeout(() => process.exit(0), 30000)"],
  {
    stdio: "ignore",
  },
);
await once(descendant, "spawn");
writeFileSync(pidFile, String(descendant.pid));
descendant.unref();
await import("./mock-acp-lifecycle.mjs");
