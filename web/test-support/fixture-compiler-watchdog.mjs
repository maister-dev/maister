import { spawn } from "node:child_process";

const parentPid = Number(process.argv[2]);

if (!process.env.MAISTER_TEST_WORKTREE_INVOCATION_ID || !Number.isSafeInteger(parentPid) || parentPid <= 1)
  throw new Error("native-reader compilation requires its invocation and parent PID");

// Bootstrap before the native identity reader exists. This detached group is
// created solely for this compiler; no unrelated process is admitted into it.
const terminate = () => process.kill(-process.pid, "SIGKILL");

if (process.ppid !== parentPid) terminate();
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
const child = spawn(process.argv[3], process.argv.slice(4), { stdio: "inherit" });

child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) throw new Error(`native compiler died from ${signal}`);
  process.exitCode = code ?? 1;
});
setInterval(() => { if (process.ppid !== parentPid) terminate(); }, 100).unref();
