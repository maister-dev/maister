// ADR-093 — POST /sidecars/:id/start|stop. Boots Fastify with a mocked
// CcrManager injected via spawnOverrides and exercises the routes through
// app.inject: happy path (state echoed), 409 when the manager is unwired, body
// id ≠ path id, invalid lifecycle, and per-instance stop targeting.
import type { CcrManager, CcrState } from "../ccr-manager";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { registerRoutes } from "../http-api";
import { SessionRegistry } from "../registry";

const silentLogger = pino({ level: "silent" });

function mockCcr(overrides: Partial<CcrManager> = {}): CcrManager {
  return {
    ensureRunning: vi.fn(async () => {}),
    getProxyUrl: vi.fn(() => "http://127.0.0.1:3456"),
    getState: vi.fn((): CcrState => "ready"),
    shutdown: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  } as CcrManager;
}

function boot(ccrManager?: CcrManager): FastifyInstance {
  const app = Fastify({ logger: false });

  registerRoutes({
    app,
    registry: new SessionRegistry(silentLogger),
    logger: silentLogger,
    runtimeRoot: "/tmp/sidecars-route-test",
    spawnOverrides: ccrManager ? { ccrManager } : undefined,
  });

  return app;
}

describe("POST /sidecars/:id/start", () => {
  it("starts the instance and echoes the supervisor-reported state (200)", async () => {
    const ccr = mockCcr({ getState: vi.fn((): CcrState => "ready") });
    const app = boot(ccr);

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/start",
      payload: {
        id: "ccr-default",
        lifecycle: "managed",
        configPath: "/c.json",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: "ready" });
    expect(ccr.ensureRunning).toHaveBeenCalledWith({
      instance: expect.objectContaining({ id: "ccr-default" }),
    });
    expect(ccr.getState).toHaveBeenCalledWith("ccr-default");
  });

  it("409 PRECONDITION when the CCR manager is not configured", async () => {
    const app = boot(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/start",
      payload: { id: "ccr-default" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PRECONDITION");
  });

  it("409 when the body id does not match the path id", async () => {
    const ccr = mockCcr();
    const app = boot(ccr);

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/start",
      payload: { id: "other-id" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/does not match/);
    expect(ccr.ensureRunning).not.toHaveBeenCalled();
  });

  it("409 on an invalid lifecycle (Zod rejection)", async () => {
    const app = boot(mockCcr());

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/start",
      payload: { id: "ccr-default", lifecycle: "bogus" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("503 EXECUTOR_UNAVAILABLE when start fails", async () => {
    const { SupervisorError } = await import("../types");
    const ccr = mockCcr({
      ensureRunning: vi.fn(async () => {
        throw new SupervisorError("EXECUTOR_UNAVAILABLE", "config missing");
      }),
    });
    const app = boot(ccr);

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/start",
      payload: { id: "ccr-default" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("EXECUTOR_UNAVAILABLE");
  });
});

describe("POST /sidecars/:id/stop", () => {
  it("stops the targeted instance and echoes state (200)", async () => {
    const ccr = mockCcr({ getState: vi.fn((): CcrState => "idle") });
    const app = boot(ccr);

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/stop",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: "idle" });
    expect(ccr.stop).toHaveBeenCalledWith("ccr-default");
  });

  it("409 PRECONDITION when the CCR manager is not configured", async () => {
    const app = boot(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/sidecars/ccr-default/stop",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PRECONDITION");
  });
});
