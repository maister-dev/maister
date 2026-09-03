// M8 T4: real POST /sessions/:id/checkpoint — unit-level coverage of
// the pendingPermissions cancel-as-reason path, the empty-body Zod
// schema, the registry reason marker, and the idempotency path.
// Full process-spawn coverage lives in lifecycle.integration.test.ts.
import type { ChildProcess } from "node:child_process";

import { EventEmitter } from "node:events";
import { join } from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEventsLog } from "../events-log";
import { EmptyPayloadSchema } from "../http-api";
import {
  createPendingPermissions,
  pendingPermissions,
} from "../pending-permissions";
import { SessionRegistry } from "../registry";

import {
  bootHost,
  cleanupRuntimeRoot,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const silentLogger = pino({ level: "silent" });

function makeFakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

function bootBare(): Promise<BootedHost> {
  return bootHost({ killGraceMs: 250 });
}

// The registered fake records carry `runId: run-<sessionId>`; a fence must
// name that run for the command to reach the route's own checks.
function command(
  kind: "session.input" | "session.cancel" | "session.checkpoint",
  sessionId: string,
  payload: Record<string, unknown> = {},
) {
  return envelope(kind, fenceFor(booted!, `run-${sessionId}`), payload);
}

async function registerExitedSession(
  registry: SessionRegistry,
  runtimeRoot: string,
  sessionId: string,
): Promise<void> {
  const emitter = new EventEmitter();
  const eventsLog = await openEventsLog(
    join(runtimeRoot, `${sessionId}.events.jsonl`),
    { logger: silentLogger },
  );

  registry.register(
    {
      sessionId,
      adapter: "claude",
      runId: `run-${sessionId}`,
      projectSlug: "demo",
      stepId: "step-1",
      sessionName: "default",
      status: "exited",
      pid: 1,
      startedAt: new Date().toISOString(),
      logPath: join(runtimeRoot, "log"),
      worktreePath: join(runtimeRoot, "wt"),
      executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
      assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
      assignmentEpoch: 1,
      createdByCommandId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
      monotonicId: 42,
    },
    makeFakeChild(),
    emitter,
    { eventsLog },
  );
}

let booted: BootedHost | null = null;

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    for (const entry of booted.registry.list()) {
      pendingPermissions.purgeSession(entry.sessionId);
    }
    await booted.stop();
    await cleanupRuntimeRoot(booted.runtimeRoot);
    booted = null;
  }
});

describe("EmptyPayloadSchema (checkpoint payload)", () => {
  it("accepts an empty object", () => {
    expect(EmptyPayloadSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys (D11 identifier-table invariant)", () => {
    const r = EmptyPayloadSchema.safeParse({ sessionId: "smuggled" });

    expect(r.success).toBe(false);
  });
});

describe("pendingPermissions.requestIds", () => {
  it("enumerates open requestIds for a session", () => {
    const reg = createPendingPermissions({ logger: silentLogger });
    const noop = () => undefined;

    reg.register("s1", "00000000-0000-0000-0000-000000000001", {
      resolve: noop,
      reject: noop,
    });
    reg.register("s1", "00000000-0000-0000-0000-000000000002", {
      resolve: noop,
      reject: noop,
    });
    reg.register("s2", "00000000-0000-0000-0000-000000000003", {
      resolve: noop,
      reject: noop,
    });

    expect(reg.requestIds("s1").sort()).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(reg.requestIds("s2")).toEqual([
      "00000000-0000-0000-0000-000000000003",
    ]);
    expect(reg.requestIds("missing")).toEqual([]);
  });
});

describe("POST /sessions/:id/checkpoint — direct route coverage", () => {
  it("unknown session returns 404 PRECONDITION", async () => {
    booted = await bootBare();
    const res = await postJson(
      `${booted.url}/sessions/no-such/checkpoint`,
      command("session.checkpoint", "no-such"),
    );

    expect(res.status).toBe(404);
  });

  it("body with unknown keys returns 409 PRECONDITION", async () => {
    booted = await bootBare();
    const res = await postJson(
      `${booted.url}/sessions/anything/checkpoint`,
      command("session.checkpoint", "anything", { smuggled: "field" }),
    );

    expect(res.status).toBe(409);
  });

  it("already-exited session returns 200 with alreadyCheckpointed: true (idempotency)", async () => {
    booted = await bootBare();
    await registerExitedSession(booted.registry, booted.runtimeRoot, "s-done");
    const res = await postJson(
      `${booted.url}/sessions/s-done/checkpoint`,
      command("session.checkpoint", "s-done"),
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      alreadyCheckpointed: boolean;
      sessionId: string;
      monotonicId: number;
    };

    expect(body.alreadyCheckpointed).toBe(true);
    expect(body.sessionId).toBe("s-done");
    expect(body.monotonicId).toBe(42);
  });
});
