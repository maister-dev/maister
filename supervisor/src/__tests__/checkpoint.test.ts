// M8 T4: real POST /sessions/:id/checkpoint — unit-level coverage of
// the pendingPermissions cancel-as-reason path, the empty-body Zod
// schema, the registry reason marker, and the idempotency path.
// Full process-spawn coverage lives in lifecycle.integration.test.ts.
import type { ChildProcess } from "node:child_process";
import type { FastifyInstance } from "fastify";

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEventsLog } from "../events-log";
import { CheckpointBodySchema, registerRoutes } from "../http-api";
import {
  createPendingPermissions,
  pendingPermissions,
} from "../pending-permissions";
import { SessionRegistry } from "../registry";

const silentLogger = pino({ level: "silent" });

type BootResult = {
  app: FastifyInstance;
  url: string;
  registry: SessionRegistry;
  runtimeRoot: string;
};

function makeFakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

async function bootBare(): Promise<BootResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "checkpoint-unit-"));
  const registry = new SessionRegistry(silentLogger);
  const app = Fastify({ logger: false });

  registerRoutes({
    app,
    registry,
    logger: silentLogger,
    runtimeRoot,
    killGraceMs: 250,
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });

  return { app, url: address, registry, runtimeRoot };
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
      status: "exited",
      pid: 1,
      startedAt: new Date().toISOString(),
      logPath: join(runtimeRoot, "log"),
      monotonicId: 42,
    },
    makeFakeChild(),
    emitter,
    { eventsLog },
  );
}

let booted: BootResult | null = null;

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    for (const entry of booted.registry.list()) {
      pendingPermissions.purgeSession(entry.sessionId);
    }
    await booted.app.close();
    await rm(booted.runtimeRoot, { recursive: true, force: true });
    booted = null;
  }
});

describe("CheckpointBodySchema", () => {
  it("accepts an empty object", () => {
    expect(CheckpointBodySchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys (D11 identifier-table invariant)", () => {
    const r = CheckpointBodySchema.safeParse({ sessionId: "smuggled" });

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
    const res = await fetch(`${booted.url}/sessions/no-such/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });

  it("body with unknown keys returns 409 PRECONDITION", async () => {
    booted = await bootBare();
    const res = await fetch(`${booted.url}/sessions/anything/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smuggled: "field" }),
    });

    expect(res.status).toBe(409);
  });

  it("already-exited session returns 200 with alreadyCheckpointed: true (idempotency)", async () => {
    booted = await bootBare();
    await registerExitedSession(booted.registry, booted.runtimeRoot, "s-done");
    const res = await fetch(`${booted.url}/sessions/s-done/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alreadyCheckpointed: boolean;
      sessionId: string;
      monotonicId: number;
    };

    expect(body.alreadyCheckpointed).toBe(true);
    expect(body.sessionId).toBe("s-done");
    expect(body.monotonicId).toBe(42);
  });
});
