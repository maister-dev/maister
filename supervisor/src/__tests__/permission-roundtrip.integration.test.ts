import type { ChildProcess } from "node:child_process";
import type { SessionRecord } from "../types";

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEventsLog } from "../events-log";
import { registerRoutes } from "../http-api";
import {
  pendingPermissions,
  type AcpPermissionOutcome,
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
  const runtimeRoot = await mkdtemp(join(tmpdir(), "permission-it-"));
  const registry = new SessionRegistry(silentLogger);
  const app = Fastify({ logger: false });

  registerRoutes({
    app,
    registry,
    logger: silentLogger,
    runtimeRoot,
    killGraceMs: 1_000,
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });

  return { app, url: address, registry, runtimeRoot };
}

async function registerFakeSession(
  registry: SessionRegistry,
  runtimeRoot: string,
  sessionId: string,
): Promise<{ record: SessionRecord; emitter: EventEmitter }> {
  const record: SessionRecord = {
    sessionId,
    adapter: "claude",
    runId: `run-${sessionId}`,
    projectSlug: "demo",
    stepId: "step-1",
    status: "live",
    pid: 1,
    startedAt: new Date().toISOString(),
    logPath: join(runtimeRoot, "log"),
    monotonicId: 0,
  };
  const emitter = new EventEmitter();
  const eventsLog = await openEventsLog(
    join(runtimeRoot, `${sessionId}.events.jsonl`),
    { logger: silentLogger },
  );

  registry.register(record, makeFakeChild(), emitter, { eventsLog });

  return { record, emitter };
}

function deferredCapture(): {
  promise: Promise<AcpPermissionOutcome>;
  resolve: (outcome: AcpPermissionOutcome) => void;
  reject: (err: Error) => void;
  resolved: () => AcpPermissionOutcome | null;
  rejected: () => Error | null;
} {
  let r: (outcome: AcpPermissionOutcome) => void = () => undefined;
  let j: (err: Error) => void = () => undefined;
  let lastResolved: AcpPermissionOutcome | null = null;
  let lastRejected: Error | null = null;
  const promise = new Promise<AcpPermissionOutcome>((res, rej) => {
    r = (outcome) => {
      lastResolved = outcome;
      res(outcome);
    };
    j = (err) => {
      lastRejected = err;
      rej(err);
    };
  });

  promise.catch(() => undefined);

  return {
    promise,
    resolve: r,
    reject: j,
    resolved: () => lastResolved,
    rejected: () => lastRejected,
  };
}

let booted: BootResult | null = null;

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    booted.registry.forEach((entry) => {
      pendingPermissions.purgeSession(entry.record.sessionId);
    });
    await booted.app.close();
    await rm(booted.runtimeRoot, { recursive: true, force: true });
    booted = null;
  }
});

describe("POST /sessions/:id/input direct validation paths", () => {
  it("malformed body returns 409 PRECONDITION", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-mb");
    const res = await fetch(`${booted.url}/sessions/s-mb/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };

    expect(body.code).toBe("PRECONDITION");
  });

  it("unknown session returns 503 EXECUTOR_UNAVAILABLE (retryable — supervisor likely restarted)", async () => {
    booted = await bootBare();
    const res = await fetch(`${booted.url}/sessions/no-such-session/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId: "00000000-0000-0000-0000-000000000000",
        optionId: "allow",
      }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };

    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("known session with unknown requestId returns 410 HITL_TIMEOUT (terminal — deferred expired)", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-unknown");
    const res = await fetch(`${booted.url}/sessions/s-unknown/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId: "11111111-1111-1111-1111-111111111111",
        optionId: "allow",
      }),
    });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string; message: string };

    expect(body.code).toBe("HITL_TIMEOUT");
    expect(body.message).toContain("pending");
  });

  it("action=select without optionId returns 409 PRECONDITION", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-nopt");
    const res = await fetch(`${booted.url}/sessions/s-nopt/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId: "22222222-2222-2222-2222-222222222222",
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };

    expect(body.code).toBe("PRECONDITION");
    expect(body.message).toContain("optionId");
  });

  it("action=cancel on unknown requestId returns 410 HITL_TIMEOUT", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-canc");
    const res = await fetch(`${booted.url}/sessions/s-canc/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "cancel",
        requestId: "33333333-3333-3333-3333-333333333333",
        reason: "test",
      }),
    });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };

    expect(body.code).toBe("HITL_TIMEOUT");
  });
});

describe("POST /sessions/:id/input permission round-trip", () => {
  it("non-uuid requestId is rejected with 409 PRECONDITION", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-select");
    const d = deferredCapture();

    pendingPermissions.register("s-select", "req-1", {
      resolve: d.resolve,
      reject: d.reject,
    });

    const res = await fetch(`${booted.url}/sessions/s-select/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId: "req-1",
        optionId: "allow",
      }),
    });

    expect(res.status).toBe(409);
    expect(d.resolved()).toBeNull();
    pendingPermissions.cancel("s-select", "req-1", "cleanup");
  });

  it("uses uuid requestId end-to-end: select resolves with selected outcome", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-uuid");
    const requestId = "44444444-4444-4444-4444-444444444444";
    const d = deferredCapture();

    pendingPermissions.register("s-uuid", requestId, {
      resolve: d.resolve,
      reject: d.reject,
    });

    const res = await fetch(`${booted.url}/sessions/s-uuid/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId,
        optionId: "allow",
      }),
    });

    expect(res.status).toBe(200);
    const outcome = await d.promise;

    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("action=cancel resolves the deferred with {outcome:cancelled}", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-cancel");
    const requestId = "55555555-5555-5555-5555-555555555555";
    const d = deferredCapture();

    pendingPermissions.register("s-cancel", requestId, {
      resolve: d.resolve,
      reject: d.reject,
    });

    const res = await fetch(`${booted.url}/sessions/s-cancel/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "cancel",
        requestId,
        reason: "DB_PERSIST_FAILED",
      }),
    });

    expect(res.status).toBe(200);
    const outcome = await d.promise;

    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  it("second select on the same requestId returns 404 after first resolves", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "s-idem");
    const requestId = "66666666-6666-6666-6666-666666666666";
    const d = deferredCapture();

    pendingPermissions.register("s-idem", requestId, {
      resolve: d.resolve,
      reject: d.reject,
    });

    const first = await fetch(`${booted.url}/sessions/s-idem/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId,
        optionId: "allow",
      }),
    });

    expect(first.status).toBe(200);

    const second = await fetch(`${booted.url}/sessions/s-idem/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId,
        optionId: "allow",
      }),
    });

    expect(second.status).toBe(410);
  });

  it("cross-session isolation: select in session A leaves session B's deferred pending", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "sA");
    await registerFakeSession(booted.registry, booted.runtimeRoot, "sB");
    const reqIdA = "77777777-7777-7777-7777-777777777777";
    const reqIdB = "88888888-8888-8888-8888-888888888888";
    const dA = deferredCapture();
    const dB = deferredCapture();

    pendingPermissions.register("sA", reqIdA, {
      resolve: dA.resolve,
      reject: dA.reject,
    });
    pendingPermissions.register("sB", reqIdB, {
      resolve: dB.resolve,
      reject: dB.reject,
    });

    const res = await fetch(`${booted.url}/sessions/sA/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId: reqIdA,
        optionId: "allow",
      }),
    });

    expect(res.status).toBe(200);
    expect(dA.resolved()).toEqual({ outcome: "selected", optionId: "allow" });
    expect(dB.resolved()).toBeNull();
    expect(pendingPermissions.size("sB")).toBe(1);
  });

  it("posting a session A's requestId to session B returns 410 (ownership boundary — deferred not found in B's pending set)", async () => {
    booted = await bootBare();
    await registerFakeSession(booted.registry, booted.runtimeRoot, "owner-A");
    await registerFakeSession(booted.registry, booted.runtimeRoot, "owner-B");
    const reqIdA = "99999999-9999-9999-9999-999999999999";
    const dA = deferredCapture();

    pendingPermissions.register("owner-A", reqIdA, {
      resolve: dA.resolve,
      reject: dA.reject,
    });

    const res = await fetch(`${booted.url}/sessions/owner-B/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "permission",
        action: "select",
        requestId: reqIdA,
        optionId: "allow",
      }),
    });

    expect(res.status).toBe(410);
    expect(dA.resolved()).toBeNull();
  });

  it("registry terminal emit purges pending permissions for that session", async () => {
    booted = await bootBare();
    const { emitter, record } = await registerFakeSession(
      booted.registry,
      booted.runtimeRoot,
      "s-purge",
    );
    const requestId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const d = deferredCapture();

    pendingPermissions.register("s-purge", requestId, {
      resolve: d.resolve,
      reject: d.reject,
    });

    record.monotonicId += 1;
    emitter.emit("session.event", {
      type: "session.exited",
      sessionId: "s-purge",
      monotonicId: record.monotonicId,
      exitCode: 0,
    });

    await expect(d.promise).rejects.toMatchObject({
      code: "CRASH",
    });
    expect(pendingPermissions.size("s-purge")).toBe(0);
  });
});
