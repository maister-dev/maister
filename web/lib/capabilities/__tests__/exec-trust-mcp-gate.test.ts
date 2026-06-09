/**
 * M27/T-C8b(3) (mcp-management.md §6.2 + error taxonomy): an MCP `stdio` server
 * spawns a LOCAL command, so it is withheld until the owning flow revision is
 * exec-trusted (the T-B3 `flow_revisions.exec_trust` axis). `sse`/`http`
 * transports connect to a remote URL (no local exec) and are NEVER gated. So an
 * untrusted revision still materializes its remote MCPs but not its stdio ones.
 */
import { describe, expect, it } from "vitest";

import {
  gateStdioMcpsByExecTrust,
  type AgentMcpServer,
} from "@/lib/capabilities/agent-map";

const stdio: AgentMcpServer = {
  name: "github",
  transport: "stdio",
  command: "github-mcp",
  args: [],
  envKeys: ["GITHUB_TOKEN"],
};
const sse: AgentMcpServer = {
  name: "remote",
  transport: "sse",
  url: "https://example.com/mcp",
  headerKeys: ["AUTH"],
};
const http: AgentMcpServer = {
  name: "http-remote",
  transport: "http",
  url: "https://example.com/h",
  headerKeys: [],
};

describe("gateStdioMcpsByExecTrust (T-C8b)", () => {
  it("trusted revision → keeps every server", () => {
    expect(gateStdioMcpsByExecTrust([stdio, sse, http], "trusted")).toEqual([
      stdio,
      sse,
      http,
    ]);
  });

  it("untrusted revision → drops stdio, keeps sse/http", () => {
    expect(gateStdioMcpsByExecTrust([stdio, sse, http], "untrusted")).toEqual([
      sse,
      http,
    ]);
  });

  it("untrusted revision with only stdio servers → empty", () => {
    expect(gateStdioMcpsByExecTrust([stdio], "untrusted")).toEqual([]);
  });

  it("empty input → empty", () => {
    expect(gateStdioMcpsByExecTrust([], "untrusted")).toEqual([]);
  });
});
