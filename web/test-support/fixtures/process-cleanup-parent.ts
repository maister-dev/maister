import { randomUUID } from "node:crypto";

import { startRealSupervisor } from "../real-supervisor";

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
  ) => Promise<{ pid: number }>;
};

const supervisor = await startRealSupervisor({
  fixtureArgs: ["--hang", "--exit-delay-ms", "60000"],
});
const health = await fetch(`${supervisor.url}/health`);
const metadata = (await health.json()) as { host: { hostKey: string } };
const adapter = await createSession(
  { ...supervisor, hostState: metadata.host },
  { runId: randomUUID() },
);

if (!process.send)
  throw new Error("cleanup parent requires its private IPC channel");
process.send({
  supervisorPid: supervisor.pid,
  adapterPid: adapter.pid,
  runtimeRoot: supervisor.runtimeRoot,
});
// This private child deliberately never calls fixture teardown. Its owner injects death after IPC readiness.
setInterval(() => {}, 1_000);
