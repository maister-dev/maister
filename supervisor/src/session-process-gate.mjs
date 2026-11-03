// @ts-check
import { spawn } from "node:child_process";

import { safeErrorCauseChain } from "../../runtime/safe-error-cause.ts";

let authorized = false;
/** @type {import("node:child_process").ChildProcess | undefined} */
let adapter;

/** @typedef {{kind: "execute", binary: string, arguments: string[], environment: Record<string,string>}} ExecuteMessage */

/** @param {unknown} value @returns {value is ExecuteMessage} */
function isExecuteMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = /** @type {Record<string,unknown>} */ (value);
  const args = Array.isArray(input.arguments)
    ? /** @type {unknown[]} */ (input.arguments)
    : null;
  const environment = input.environment;

  return (
    Object.keys(input).length === 4 &&
    input.kind === "execute" &&
    typeof input.binary === "string" &&
    args !== null &&
    args.every((argument) => typeof argument === "string") &&
    environment !== null &&
    typeof environment === "object" &&
    !Array.isArray(environment) &&
    Object.values(environment).every((value) => typeof value === "string")
  );
}

/** @param {unknown} error */
function reportSpawnFailure(error) {
  const failure = {
    version: 1,
    stage: "spawn",
    causeChain: safeErrorCauseChain(error),
  };

  if (!process.send || !process.connected) process.exit(127);
  process.send({ kind: "execution_failed", failure }, () => process.exit(127));
}

process.on("disconnect", () => {
  if (!authorized) process.exit(125);
});

/** @type {readonly ("SIGTERM" | "SIGINT")[]} */
const signals = ["SIGTERM", "SIGINT"];

for (const signal of signals) {
  process.on(signal, () => {
    if (adapter && adapter.exitCode === null && adapter.signalCode === null)
      adapter.kill(signal);
    else process.exit(125);
  });
}

process.once("message", (message) => {
  if (!isExecuteMessage(message)) process.exit(125);
  authorized = true;
  try {
    // The adapter inherits the durably recorded group and actual stdio.
    // Native spawn retains exact errno instead of execve's fatal-abort path.
    const child = spawn(message.binary, message.arguments, {
      env: message.environment,
      stdio: ["inherit", "inherit", "inherit"],
    });
    adapter = child;
    child.once("error", reportSpawnFailure);
    child.once("spawn", () =>
      process.send?.({ kind: "execution_started", adapterPid: child.pid }),
    );
    child.once("exit", (code) => process.exit(code ?? 1));
  } catch (error) {
    reportSpawnFailure(error);
  }
});

if (!process.send) process.exit(125);
process.send({ kind: "ready" });
