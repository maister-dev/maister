import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"],
  { stdio: "ignore" },
);

process.on("SIGTERM", () => {});
process.stdout.write(`ready:${child.pid}\n`);
setInterval(() => {}, 1_000);
