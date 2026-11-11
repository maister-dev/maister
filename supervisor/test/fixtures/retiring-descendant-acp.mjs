import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

const pidFile = process.env.MAISTER_DESCENDANT_PID_FILE;

if (!pidFile)
  throw new Error("The retiring descendant fixture requires its PID file");
const descendant = spawn(
  process.execPath,
  [
    "-e",
    `process.on('SIGTERM', () => {});
     process.on('SIGUSR2', () => process.exit(0));
     setTimeout(() => process.exit(1), 30000);
     process.send('ready');`,
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);

await once(descendant, "message");
writeFileSync(pidFile, String(descendant.pid));
descendant.disconnect();
descendant.unref();
await import("./mock-acp-lifecycle.mjs");
