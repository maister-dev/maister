import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { startRealSupervisor } from "../real-supervisor";
import { captureOwnedAdapterProcess } from "../capture-supervisor-process-groups";
import {
  invocationFromEnvironment,
  invocationEnvironment,
  processIdentity,
  readProcessSnapshot,
  registerSpawnedProcess,
} from "../process-invocation";

// Load the supervisor package's test helper at runtime so the web compiler
// does not type-check the supervisor graph against the web package's Node types.
const { createSession } = (await import(
  new URL(
    "../../../supervisor/src/__tests__/_fixtures/boot-host.ts",
    import.meta.url,
  ).href
)) as {
  createSession: (
    host: { url: string; runtimeRoot: string; hostState: { hostKey: string } },
    fence: { runId: string },
  ) => Promise<{ pid: number; sessionId: string; acpSessionId: string }>;
};

const supervisor = await startRealSupervisor({
  fixtureArgs: ["--hang", "--exit-delay-ms", "60000"],
});
const health = await fetch(`${supervisor.url}/health`);
const metadata = (await health.json()) as { host: { hostKey: string } };
const runId = randomUUID();
const adapter = await createSession(
  { ...supervisor, hostState: metadata.host },
  { runId },
);
const invocation = invocationFromEnvironment();

if (!invocation) throw new Error("Cleanup parent requires an owned invocation");
const captured = await captureOwnedAdapterProcess({
  invocation,
  supervisor,
  sessionId: adapter.sessionId,
  expected: { runId, acpSessionId: adapter.acpSessionId },
});
const parent = await processIdentity(invocation, process.pid);
const snapshot = await readProcessSnapshot(invocation);
const groups = [supervisor.pid, captured.gate.pgid].map((pgid) =>
  snapshot.filter((entry) => entry.pgid === pgid && !entry.zombie),
);
// This watcher must survive its deliberately killed owner. The adapter's
// managed gate never inherits a preload or weaker bootstrap environment.
const { NODE_OPTIONS: inheritedNodeOptions, ...environment } = process.env;

void inheritedNodeOptions;
const watchdog = spawn(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    fileURLToPath(
      new URL("./process-cleanup-session-watchdog.ts", import.meta.url),
    ),
  ],
  {
    env: { ...environment, ...invocationEnvironment(invocation) },
    detached: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  },
);
const watchdogReady = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Session watchdog readiness timed out")),
    10_000,
  );

  watchdog.once("message", (message) => {
    clearTimeout(timer);
    if ((message as { ready?: boolean }).ready === true) resolve();
    else reject(new Error("Session watchdog returned invalid readiness"));
  });
  watchdog.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  watchdog.once("exit", (code, signal) => {
    clearTimeout(timer);
    reject(
      new Error(`Session watchdog exited before readiness: ${code}/${signal}`),
    );
  });
});

// Registration failure is reported by the owner; retain readiness rejection until observed.
void watchdogReady.catch(() => undefined);
await registerSpawnedProcess(
  invocation,
  {
    role: "fixture",
    caseName: "O2",
    rootRole: "session-watchdog",
    root: supervisor.runtimeRoot,
    bootId: "O2-watchdog",
    logFile: null,
  },
  watchdog,
);
watchdog.send({ parent, groups });
await watchdogReady;

if (!process.send)
  throw new Error("cleanup parent requires its private IPC channel");
process.send({
  supervisorPid: supervisor.pid,
  adapterPid: captured.adapter.pid,
  gatePid: captured.gate.pid,
  watchdogPid: watchdog.pid,
  runtimeRoot: supervisor.runtimeRoot,
});
// This private child deliberately never calls fixture teardown. Its owner injects death after IPC readiness.
setInterval(() => {}, 1_000);
