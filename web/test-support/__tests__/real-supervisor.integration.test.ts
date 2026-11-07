// The real-supervisor harness captures its detached session groups so
// `kill()` reaches the adapter children it spawned (no PID-1 orphans), and
// the inherited environment is scrubbed of every execution-host setting so a
// developer/CI pin cannot give every child one identity.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { asExecutionWorkspaceId } from "@/lib/execution-host/types";
import { captureOwnedAdapterProcess } from "@/test-support/capture-supervisor-process-groups";
import {
  invocationFromEnvironment,
  readProcessSnapshot,
} from "@/test-support/process-invocation";
import { retryFixturePortAllocation } from "@/test-support/owned-fixture";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
  type RealSupervisor,
} from "@/test-support/real-supervisor";

const PINNED_KEY = "eh_pinned_by_ci_00000000";

let sup: RealSupervisor | null = null;
let restoreUrl: () => void = () => {};
const previousPin = process.env.MAISTER_EXECUTION_HOST_KEY;

afterEach(async () => {
  restoreUrl();
  if (previousPin === undefined) delete process.env.MAISTER_EXECUTION_HOST_KEY;
  else process.env.MAISTER_EXECUTION_HOST_KEY = previousPin;
  await sup?.kill();
  sup = null;
});

describe("real-supervisor harness", () => {
  it("reallocates a raced port after retiring the failed owned supervisor and preserves the competing listener", async () => {
    const competing = createServer((_request, response) => {
      response.end(JSON.stringify({ source: "competing-listener" }));
    });
    const listening = once(competing, "listening");

    competing.listen(0, "0.0.0.0");
    await listening;
    const address = competing.address();

    if (!address || typeof address === "string")
      throw new Error("Competing listener has no TCP address");
    let starts = 0;

    try {
      sup = await retryFixturePortAllocation(async () => {
        starts += 1;

        return startRealSupervisor(starts === 1 ? { port: address.port } : {});
      });
      expect(starts).toBe(2);
      expect(sup.port).not.toBe(address.port);
      expect((await fetch(`${sup.url}/health`)).status).toBe(200);
      let refusedStarts = 0;

      await expect(
        retryFixturePortAllocation(async () => {
          refusedStarts += 1;

          return startRealSupervisor({ port: address.port });
        }),
      ).rejects.toThrow("EADDRINUSE");
      expect(refusedStarts).toBe(3);
      expect(
        await (await fetch(`http://127.0.0.1:${address.port}/health`)).json(),
      ).toEqual({ source: "competing-listener" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        competing.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 60_000);

  it("refuses a non-port startup error without retries or changing its state file", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "supervisor-state-refusal-"),
    );
    const stateDir = path.join(root, "state-is-a-file");
    let starts = 0;

    try {
      await writeFile(stateDir, "retained");
      await expect(
        retryFixturePortAllocation(async () => {
          starts += 1;

          return startRealSupervisor({ stateDir });
        }),
      ).rejects.toThrow("supervisor startup failed");
      expect(starts).toBe(1);
      expect(await readFile(stateDir, "utf8")).toBe("retained");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("kills its captured session groups — the adapter child dies with the supervisor — and scrubs the inherited host pin", async () => {
    process.env.MAISTER_EXECUTION_HOST_KEY = PINNED_KEY;
    sup = await startRealSupervisor({ fixtureArgs: ["--hang"] });
    restoreUrl = useRealSupervisorUrl(sup.url);
    const wire = createLocalDirectTransport();
    const health = await wire.health();

    expect(health.kind).toBe("ready");
    if (health.kind !== "ready") return;
    // The pin in this process's environment never reached the child.
    expect(health.identity?.hostKey).not.toBe(PINNED_KEY);

    // Spawn an adapter: the fixture hangs, so it stays alive in the group.
    const runId = `run-${randomUUID()}`;
    const fence = {
      hostKey: health.identity!.hostKey,
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
      runId,
    };
    const dir = path.join(sup.runtimeRoot, "harness", runId);

    await mkdir(dir, { recursive: true });
    const adopted = await wire.adoptWorkspace(
      buildEnvelope({
        commandId: randomUUID(),
        kind: "workspace.adopt",
        ...fence,
        payload: {
          runId,
          projectSlug: "harness",
          kind: "directory",
          path: dir,
        },
      }),
    );
    const created = await wire.createSession(
      buildEnvelope({
        commandId: randomUUID(),
        kind: "session.create",
        ...fence,
        payload: {
          executionWorkspaceId: asExecutionWorkspaceId(
            adopted.executionWorkspaceId,
          ),
          stepId: "s1",
          executor: { agent: "claude", model: "mock" },
        },
      }),
    );

    const invocation = invocationFromEnvironment();

    if (!invocation)
      throw new Error("Supervisor harness requires an owned invocation");
    const captured = await captureOwnedAdapterProcess({
      invocation,
      supervisor: sup,
      sessionId: created.sessionId,
      expected: { runId, assignmentId: fence.assignmentId, assignmentEpoch: 1 },
    });

    expect(created.pid).toBe(captured.gate.pid);
    expect(captured.adapter.pid).not.toBe(created.pid);
    expect(captured.adapter.pgid).toBe(captured.gate.pid);
    expect(captured.adapter.ppid).toBe(captured.gate.pid);
    const pid = sup.pid;
    const group = captured.gate.pgid;

    await sup.kill();
    sup = null;

    expect(
      (await readProcessSnapshot(invocation)).filter(
        (entry) =>
          !entry.zombie && (entry.pgid === pid || entry.pgid === group),
      ),
    ).toEqual([]);
  }, 60_000);
});
