// Interrupt route: POST /sessions/:id/cancel sends a protocol-level
// session/cancel without tearing the session down. Unit-level coverage of the
// 404 path, the idempotent no-live-turn ack, and the live-session path (cancel
// notification fired + pending permissions released + cancelRequested flag set).
import type { ChildProcess } from "node:child_process";
import type { FastifyInstance } from "fastify";

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openEventsLog } from "../events-log";
import { registerRoutes } from "../http-api";
import { pendingPermissions } from "../pending-permissions";
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
  const runtimeRoot = await mkdtemp(join(tmpdir(), "cancel-unit-"));
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

async function registerSession(
  registry: SessionRegistry,
  runtimeRoot: string,
  sessionId: string,
  opts: {
    status: "live" | "exited";
    connection?: { cancel: ReturnType<typeof vi.fn> };
    acpSessionId?: string;
  },
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
      status: opts.status,
      pid: 1,
      startedAt: new Date().toISOString(),
      logPath: join(runtimeRoot, "log"),
      worktreePath: join(runtimeRoot, "wt"),
      monotonicId: 1,
    },
    makeFakeChild(),
    emitter,
    {
      eventsLog,
      connection: opts.connection as never,
      acpSessionId: opts.acpSessionId,
    },
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

describe("POST /sessions/:id/cancel", () => {
  it("returns 404 for an unknown session", async () => {
    booted = await bootBare();
    const res = await fetch(`${booted.url}/sessions/missing/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(404);
  });

  it("acks cancelled:false for a session with no live turn", async () => {
    booted = await bootBare();
    await registerSession(booted.registry, booted.runtimeRoot, "s-exited", {
      status: "exited",
    });

    const res = await fetch(`${booted.url}/sessions/s-exited/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { cancelled: boolean }).toMatchObject({
      cancelled: false,
    });
  });

  it("fires session/cancel, releases pending permissions, and flags the record on a live session", async () => {
    booted = await bootBare();
    const cancel = vi.fn().mockResolvedValue(undefined);

    await registerSession(booted.registry, booted.runtimeRoot, "s-live", {
      status: "live",
      connection: { cancel },
      acpSessionId: "acp-1",
    });

    let cancelledReason: string | null = null;

    pendingPermissions.register(
      "s-live",
      "00000000-0000-0000-0000-000000000001",
      {
        resolve: (outcome) => {
          cancelledReason = (outcome as { outcome?: string }).outcome ?? null;
        },
        reject: () => undefined,
      },
    );

    const res = await fetch(`${booted.url}/sessions/s-live/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { cancelled: boolean }).toMatchObject({
      cancelled: true,
    });
    expect(cancel).toHaveBeenCalledWith({ sessionId: "acp-1" });
    expect(cancelledReason).toBe("cancelled");
    expect(booted.registry.get("s-live")?.record.cancelRequested).toBe(true);
  });
});
