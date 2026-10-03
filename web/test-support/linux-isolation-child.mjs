import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertLinuxMountedPolicy,
  decodeLinuxCommand,
  decodeLinuxIsolationPolicy,
} from "./linux-isolation-protocol.ts";

// Applications may signal their same-UID ancestor. Keep that signal inert;
// --disable-sigusr1 also prevents Node's native inspector activation.
process.on("SIGUSR1", () => undefined);

/** @param {import('./linux-isolation-protocol.ts').LinuxChildFrame} frame */
function frame(frame) {
  writeSync(1, `${JSON.stringify(frame)}\n`);
}

/** @param {'stdout' | 'stderr'} stream @param {Buffer} chunk */
function output(stream, chunk) {
  for (let offset = 0; offset < chunk.length; offset += 8192)
    frame({
      type: "output",
      stream,
      data: chunk.subarray(offset, offset + 8192).toString("base64"),
    });
}

try {
  const policy = decodeLinuxIsolationPolicy(process.argv[2] ?? "");
  const command = decodeLinuxCommand(process.argv[3] ?? "");

  assertLinuxMountedPolicy(policy);
  if (command[0] !== process.execPath)
    throw new Error("isolated fixtures require the approved Node executable");
  const readyPreload = fileURLToPath(
    new URL("./linux-isolation-ready.mjs", import.meta.url),
  );
  const child = spawn(
    command[0],
    ["--import", readyPreload, ...command.slice(1)],
    {
      cwd: policy.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  let handshake = "";
  let acknowledged = false;

  child.stdio[3].on("data", (chunk) => {
    handshake += chunk.toString();
    if (
      handshake.length > 32 ||
      (handshake.includes("\n") && handshake !== `${child.pid}\n`)
    )
      throw new Error("invalid application readiness handshake");
    if (handshake === `${child.pid}\n`)
      frame({ type: "ready", bridgePid: process.pid, appPid: child.pid });
  });
  process.stdin.once("data", (chunk) => {
    if (acknowledged || chunk.length !== 1 || chunk[0] !== 1)
      throw new Error("invalid isolation identity acknowledgement");
    acknowledged = true;
    child.stdio[3].end(Buffer.from([1]));
    process.stdin.destroy();
  });
  child.stdout.on("data", (chunk) => output("stdout", chunk));
  child.stderr.on("data", (chunk) => output("stderr", chunk));
  child.once("error", (error) => {
    frame({ type: "error", message: error.message.slice(0, 8192) });
    process.exitCode = 125;
  });
  child.once("close", (code, signal) => {
    if (code === null && signal === null) return;
    frame({ type: "exit", code, signal });
  });
} catch (error) {
  frame({
    type: "error",
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      8192,
    ),
  });
  process.exitCode = 125;
}
