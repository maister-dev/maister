import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { describe, expect, it } from "vitest";

import { partitionWithheldMcps } from "@/lib/mcp/materialization-gate";

// ADR-129 (W-E): one structured withheld pass over the materialized MCP set,
// applying BOTH the platform-trust gate (source='platform' + untrusted) and the
// exec-trust stdio gate. No silent warn-only path.

const srv = (
  name: string,
  transport: AgentMcpServer["transport"],
): AgentMcpServer => ({ name, transport });

describe("partitionWithheldMcps (W-E)", () => {
  it("keeps a trusted platform MCP", () => {
    const { kept, withheld } = partitionWithheldMcps({
      mcpServers: [srv("github", "stdio")],
      sourceByRef: new Map([["github", "platform"]]),
      platformTrustedByRef: new Map([["github", true]]),
      execTrust: "trusted",
    });

    expect(kept.map((s) => s.name)).toEqual(["github"]);
    expect(withheld).toEqual([]);
  });

  it("withholds an untrusted platform MCP (visible-not-executable) with reason platform-untrusted", () => {
    const { kept, withheld } = partitionWithheldMcps({
      mcpServers: [srv("serena", "stdio")],
      sourceByRef: new Map([["serena", "platform"]]),
      platformTrustedByRef: new Map([["serena", false]]),
      execTrust: "trusted",
    });

    expect(kept).toEqual([]);
    expect(withheld).toEqual([
      {
        refId: "serena",
        transport: "stdio",
        reason: "platform-untrusted",
        scope: "platform",
      },
    ]);
  });

  it("withholds an exec-untrusted stdio MCP with reason exec-untrusted-stdio", () => {
    const { kept, withheld } = partitionWithheldMcps({
      mcpServers: [srv("fs", "stdio"), srv("remote", "http")],
      sourceByRef: new Map([
        ["fs", "flow-package"],
        ["remote", "flow-package"],
      ]),
      platformTrustedByRef: new Map(),
      execTrust: "untrusted",
    });

    expect(kept.map((s) => s.name)).toEqual(["remote"]); // http not gated
    expect(withheld).toEqual([
      {
        refId: "fs",
        transport: "stdio",
        reason: "exec-untrusted-stdio",
        scope: "flow-package",
      },
    ]);
  });

  it("platform-untrusted takes precedence over exec-trust for the same server", () => {
    const { kept, withheld } = partitionWithheldMcps({
      mcpServers: [srv("serena", "stdio")],
      sourceByRef: new Map([["serena", "platform"]]),
      platformTrustedByRef: new Map([["serena", false]]),
      execTrust: "untrusted",
    });

    expect(kept).toEqual([]);
    expect(withheld[0].reason).toBe("platform-untrusted");
    expect(withheld).toHaveLength(1);
  });

  it("a project-sourced stdio MCP is unaffected by the platform-trust gate when exec-trusted", () => {
    const { kept, withheld } = partitionWithheldMcps({
      mcpServers: [srv("local", "stdio")],
      sourceByRef: new Map([["local", "project"]]),
      platformTrustedByRef: new Map(),
      execTrust: "trusted",
    });

    expect(kept.map((s) => s.name)).toEqual(["local"]);
    expect(withheld).toEqual([]);
  });
});
