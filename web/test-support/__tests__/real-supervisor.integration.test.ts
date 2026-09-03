// The real-supervisor harness: the child leads its own process group so
// `kill()` reaches the adapter children it spawned (no PID-1 orphans), and
// the inherited environment is scrubbed of every execution-host setting so a
// developer/CI pin cannot give every child one identity.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { asExecutionWorkspaceId } from "@/lib/execution-host/types";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
  type RealSupervisor,
} from "@/test-support/real-supervisor";

const PINNED_KEY = "eh_pinned_by_ci_00000000";

function pgrep(args: string[]): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("pgrep", args, (err, stdout) => {
      if (err) {
        resolve([]);

        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((l) => Number.parseInt(l.trim(), 10))
          .filter((pid) => Number.isFinite(pid)),
      );
    });
  });
}

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
  it("kills the whole process group — the adapter child dies with the supervisor — and scrubs the inherited host pin", async () => {
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

    expect(created.pid).toBeGreaterThan(0);
    const group = await pgrep(["-g", String(sup.pid)]);

    // The supervisor leads the group and the adapter is a member of it.
    expect(group).toContain(sup.pid);
    expect(group).toContain(created.pid);
    expect(await pgrep(["-f", sup.fixturePath])).toContain(created.pid);

    const { pid, fixturePath } = sup;

    await sup.kill();
    sup = null;

    expect(await pgrep(["-g", String(pid)])).toEqual([]);
    expect(await pgrep(["-f", fixturePath])).not.toContain(created.pid);
  }, 60_000);
});
