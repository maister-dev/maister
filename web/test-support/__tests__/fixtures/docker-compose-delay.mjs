#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const binary = process.env.MAISTER_DOCKER_CONTROL_BINARY;
const evidence = process.env.MAISTER_DOCKER_CONTROL_EVIDENCE;
const args = process.argv.slice(2);
const delayMs = Number(process.env.MAISTER_DOCKER_CONTROL_DELAY_MS);

if (
  !binary ||
  !isAbsolute(binary) ||
  !evidence ||
  !Number.isInteger(delayMs) ||
  delayMs < 1 ||
  delayMs > 35_000
)
  throw new Error(
    "real Compose discovery control requires its Docker binary and evidence path",
  );

if (args[0] === "compose" && args[1] === "version") {
  const startedAt = Date.now();

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await appendFile(
    evidence,
    `${JSON.stringify({ event: "real-compose-discovery", delayMs: Date.now() - startedAt })}\n`,
  );
}

const child = spawn(binary, args, { stdio: "inherit" });

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
