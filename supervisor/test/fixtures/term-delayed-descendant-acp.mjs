import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

const pidFile = process.env.MOCK_ACP_DESCENDANT_PID_FILE;
if (!pidFile)
  throw new Error("The delayed-retirement fixture requires its PID file");
const descendant = spawn(
  process.execPath,
  [
    "-e",
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); process.send('ready'); setInterval(() => {}, 1000);",
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
await once(descendant, "message");
writeFileSync(pidFile, String(descendant.pid));
descendant.disconnect();
descendant.unref();
await import("./mock-acp-lifecycle.mjs");
