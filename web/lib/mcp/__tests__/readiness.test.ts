import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";

import { describe, expect, it } from "vitest";

import { evaluateMcpReadiness } from "@/lib/mcp/readiness";

function readyDiag(
  envRefs: { name: string; present: boolean }[],
): SupervisorDiagnosticsStatus {
  return {
    kind: "ready",
    diagnostics: {
      status: "ready",
      version: "1.0.0",
      checkedAt: "2026-06-13T00:00:00.000Z",
      adapters: [],
      sidecars: [],
      envRefs,
    },
  };
}

describe("evaluateMcpReadiness", () => {
  it("is Ready for a stdio server with a command and present env refs", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "stdio",
        command: "npx",
        envKeys: ["env:GH_TOKEN"],
        headerKeys: [],
      },
      readyDiag([{ name: "GH_TOKEN", present: true }]),
    );

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });

  it("is NotReady when a stdio server has no command", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: null, envKeys: [], headerKeys: [] },
      readyDiag([]),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("missing command");
  });

  it("is NotReady when an sse/http server has no url", () => {
    const result = evaluateMcpReadiness(
      { transport: "sse", url: null, envKeys: [], headerKeys: [] },
      readyDiag([]),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("missing url");
  });

  it("flags a missing env ref by name with the env: prefix stripped", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "http",
        url: "https://example.test",
        headerKeys: ["env:API_KEY"],
        envKeys: [],
      },
      readyDiag([{ name: "API_KEY", present: false }]),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("env ref missing: API_KEY");
  });

  it("accepts a bare env name without the env: prefix", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "stdio",
        command: "npx",
        envKeys: ["GH_TOKEN"],
        headerKeys: [],
      },
      readyDiag([{ name: "GH_TOKEN", present: true }]),
    );

    expect(result.status).toBe("Ready");
  });

  it("is Unknown when supervisor diagnostics are unavailable", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx", envKeys: [], headerKeys: [] },
      { kind: "unavailable", reason: "network", message: "down" },
    );

    expect(result.status).toBe("Unknown");
    expect(result.reasons[0]).toContain("diagnostics unavailable");
  });

  it("is Unknown when diagnostics are null", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx" },
      null,
    );

    expect(result.status).toBe("Unknown");
  });
});
