import { describe, expect, it } from "vitest";

import { extractToolIdentity, mcpServerFromToolName } from "../guardrail-hooks";

// ADR-130: the capability_guard seam needs a tool NAME (and, for MCP calls, a
// server namespace). Identity is single-sourced here and reused by both the
// smoke probe (Phase 1) and resolveCapabilityGuardDecision (Phase 2).
describe("extractToolIdentity", () => {
  it("prefers the claude _meta.claudeCode.toolName", () => {
    expect(
      extractToolIdentity({
        title: "some title",
        _meta: { claudeCode: { toolName: "Edit" } },
      }),
    ).toEqual({ name: "Edit", mcpServer: null });
  });

  it("falls back to title when _meta has no toolName", () => {
    expect(extractToolIdentity({ title: "Bash" })).toEqual({
      name: "Bash",
      mcpServer: null,
    });
  });

  it("resolves the MCP server namespace from an mcp__server__tool name", () => {
    expect(
      extractToolIdentity({
        _meta: { claudeCode: { toolName: "mcp__github__create_issue" } },
      }),
    ).toEqual({ name: "mcp__github__create_issue", mcpServer: "github" });
  });

  it("resolves the MCP server from an mcp__ title", () => {
    expect(extractToolIdentity({ title: "mcp__maister__hitl_list" })).toEqual({
      name: "mcp__maister__hitl_list",
      mcpServer: "maister",
    });
  });

  it("returns a null name for a call with no extractable identity", () => {
    expect(extractToolIdentity({ kind: "edit" })).toEqual({
      name: null,
      mcpServer: null,
    });
    expect(extractToolIdentity({ title: "" })).toEqual({
      name: null,
      mcpServer: null,
    });
    expect(extractToolIdentity(null)).toEqual({ name: null, mcpServer: null });
  });
});

describe("mcpServerFromToolName", () => {
  it("extracts the server from mcp__<server>__<tool>", () => {
    expect(mcpServerFromToolName("mcp__github__create_issue")).toBe("github");
  });

  it("returns null for a non-MCP tool name", () => {
    expect(mcpServerFromToolName("Edit")).toBeNull();
  });

  it("returns null for a malformed MCP name with no tool segment", () => {
    expect(mcpServerFromToolName("mcp__github")).toBeNull();
    expect(mcpServerFromToolName("mcp____tool")).toBeNull();
  });
});
