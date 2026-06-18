// ADR-094 regression: the production registerRoutes options MUST wire the CCR
// manager into spawnOverrides. Without it, POST /sidecars/:id/start|stop return
// 409 in production (those routes have no defaultCcrManager fallback, unlike the
// session-spawn path in spawn.ts). main.ts is the only production caller of
// registerRoutes; this guards its option-builder against dropping the wiring.
// Importing ../main is safe: its auto-start is gated on !process.env.VITEST.
import type { CcrManager, CcrState } from "../ccr-manager";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { buildRegisterRoutesOptions } from "../main";

const silentLogger = pino({ level: "silent" });

function mockCcr(): CcrManager {
  return {
    ensureRunning: vi.fn(async () => {}),
    getProxyUrl: vi.fn(() => "http://127.0.0.1:3456"),
    getState: vi.fn((): CcrState => "idle"),
    listStates: vi.fn(() => []),
    shutdown: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as CcrManager;
}

describe("buildRegisterRoutesOptions (ADR-094 prod wiring)", () => {
  it("wires the CCR manager into spawnOverrides so /sidecars routes are reachable", () => {
    const ccr = mockCcr();

    const opts = buildRegisterRoutesOptions({
      app: {} as never,
      registry: {} as never,
      logger: silentLogger,
      runtimeRoot: "/tmp/main-wiring-test",
      killGraceMs: 5_000,
      ccrManager: ccr,
    });

    expect(opts.spawnOverrides?.ccrManager).toBe(ccr);
    expect(opts.modelCatalog?.registry).toBeDefined();
  });
});
