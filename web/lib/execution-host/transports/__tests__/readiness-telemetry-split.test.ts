import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";

const READY_BODY = {
  status: "ready",
  host: {
    hostKey: "1d243f70-235f-47bd-804b-33aa3c8c78db",
    bootId: "2f6a1c58-0a1e-4a9b-9f0a-2b7c6d4e5f10",
    protocolVersion: 1,
  },
  version: "0.0.1",
  uptimeMs: 42,
  checkedAt: "2026-09-22T09:00:00.000Z",
  sessions: { live: 0, exited: 0, crashed: 0 },
};

// P0-7 D5 + Rollout §2: an opt-in stream snapshot failure answers a typed 503
// rather than omitting the block, so the ONLY way a telemetry fault stops being
// a launch refusal is for the readiness probe not to request it.
function supervisorWhoseTelemetryIsBroken(): Array<string> {
  const urls: Array<string> = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      urls.push(url);
      if (url.includes("includeStream=true")) {
        return new Response(
          JSON.stringify({
            code: "EXECUTOR_UNAVAILABLE",
            message: "runtime event health snapshot is unavailable",
            details: { reason: "stream_health_unavailable" },
          }),
          { status: 503 },
        );
      }

      return new Response(JSON.stringify(READY_BODY), { status: 200 });
    }),
  );

  return urls;
}

describe("readiness is decoupled from stream telemetry", () => {
  beforeEach(() => {
    process.env.MAISTER_SUPERVISOR_URL = "http://supervisor:7777";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MAISTER_SUPERVISOR_URL;
  });

  it("keeps the host ready when only the telemetry snapshot fails", async () => {
    const urls = supervisorWhoseTelemetryIsBroken();
    const health = await createLocalDirectTransport().health();

    expect(urls).toEqual(["http://supervisor:7777/health?includeStream=false"]);
    expect(health.kind).toBe("ready");
    if (health.kind !== "ready") return;
    expect(health.identity?.hostKey).toBe(READY_BODY.host.hostKey);
  });

  it("still surfaces the telemetry fault on the diagnostics path", async () => {
    supervisorWhoseTelemetryIsBroken();
    const status = await createLocalDirectTransport().platformStatus();

    expect(status).toMatchObject({ kind: "unavailable", reason: "http" });
  });
});
