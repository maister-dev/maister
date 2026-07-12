#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const pidPath = process.env.MAISTER_SMOKE_CHILD_PID_PATH;
const termPath = process.env.MAISTER_SMOKE_CHILD_TERM_PATH;

if (!pidPath || !termPath) {
  throw new Error("smoke child pid and TERM paths are required");
}

writeFileSync(pidPath, String(process.pid), "utf8");
process.on("SIGTERM", () => {
  writeFileSync(termPath, "received", "utf8");
});

setInterval(() => {}, 1 << 30);
