import type {
  McpDiagnosticsInput,
  McpReadinessContext,
} from "@/lib/mcp/readiness";

import { describe, expect, it } from "vitest";

import { evaluateMcpReadiness } from "@/lib/mcp/readiness";

// ADR-177: presence comes from the HOST (`POST /diagnostics/env-refs`), not from
// the fixed `GET /diagnostics.envRefs` catalog. `adapters` keeps the old
// diagnostics shape because the adapter gate is unchanged.

function diagWithAdapters(
  adapters: { id: string; available: boolean }[],
): McpDiagnosticsInput {
  return { kind: "ready", diagnostics: { envRefs: [], adapters } };
}

function ctx(
  presence: { name: string; present: boolean }[] | null = [],
  adapters: { id: string; available: boolean }[] = [],
): McpReadinessContext {
  return { presence, adapters: diagWithAdapters(adapters) };
}

describe("evaluateMcpReadiness", () => {
  it("is Ready for a stdio server with a command and a present reference", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx", env: { GH: "env:GH_TOKEN" } },
      ctx([{ name: "GH_TOKEN", present: true }]),
    );

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });

  it("is NotReady when a stdio server has no command", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: null },
      ctx(),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("missing command");
  });

  it("is NotReady when an sse/http server has no url", () => {
    const result = evaluateMcpReadiness({ transport: "sse", url: null }, ctx());

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("missing url");
  });

  it("flags a missing reference by the NAME behind the env: value", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "http",
        url: "https://example.test",
        headers: { "X-Api-Key": "env:API_KEY" },
      },
      ctx([{ name: "API_KEY", present: false }]),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("env ref missing: API_KEY");
  });

  it("checks the name behind bearerTokenEnv too", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "http",
        url: "https://example.test",
        bearerTokenEnv: "env:MCP_TOKEN",
      },
      ctx([{ name: "MCP_TOKEN", present: false }]),
    );

    expect(result.reasons).toContain("env ref missing: MCP_TOKEN");
  });

  it("NEVER flags a literal value — it references nothing", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "stdio",
        command: "npx",
        env: { FASTMCP_LOG_LEVEL: "ERROR", GH_HOST: "github.com" },
      },
      // An empty presence list is an ANSWER, not a failure: no names were asked
      // about because no value referenced one.
      ctx([]),
    );

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });

  it("reads presence from the host, independently of diagnostics.envRefs", () => {
    // The defect this closes: the fixed `/diagnostics` catalog enumerates
    // provider credentials, so a name absent from it was flagged even when the
    // host had it.
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx", env: { GH: "env:GH_TOKEN" } },
      {
        presence: [{ name: "GH_TOKEN", present: true }],
        adapters: diagWithAdapters([]),
      },
    );

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });

  it("is Unknown when supervisor diagnostics are unavailable", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx" },
      {
        presence: [],
        adapters: { kind: "unavailable", reason: "network", message: "down" },
      },
    );

    expect(result.status).toBe("Unknown");
    expect(result.reasons[0]).toContain("diagnostics unavailable");
  });

  it("is Unknown when diagnostics are null", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx" },
      { presence: [], adapters: null },
    );

    expect(result.status).toBe("Unknown");
  });

  it("is Unknown when the host env-ref read failed", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx", env: { GH: "env:GH_TOKEN" } },
      ctx(null),
    );

    expect(result.status).toBe("Unknown");
    expect(result.reasons).toContain("host env-ref presence unavailable");
  });

  it("is NotReady when none of the declared supported agents' adapters are available", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "stdio",
        command: "npx",
        supportedAgents: ["gemini", "mimo"],
      },
      ctx(
        [],
        [
          { id: "claude", available: true },
          { id: "gemini", available: false },
          { id: "mimo", available: false },
        ],
      ),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain(
      "no supported adapter available: gemini, mimo",
    );
  });

  it("is Ready when at least one supported agent's adapter is available", () => {
    const result = evaluateMcpReadiness(
      {
        transport: "stdio",
        command: "npx",
        supportedAgents: ["claude", "gemini"],
      },
      ctx(
        [],
        [
          { id: "claude", available: true },
          { id: "gemini", available: false },
        ],
      ),
    );

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });

  it("is NotReady with a generic reason when no agents are declared and no adapter is available", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx" },
      ctx(
        [],
        [
          { id: "claude", available: false },
          { id: "codex", available: false },
        ],
      ),
    );

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("no adapter available");
  });

  it("skips the adapter gate when diagnostics report no adapters", () => {
    const result = evaluateMcpReadiness(
      { transport: "stdio", command: "npx", supportedAgents: ["gemini"] },
      ctx([], []),
    );

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });
});
