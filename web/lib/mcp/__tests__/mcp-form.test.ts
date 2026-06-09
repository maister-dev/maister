import { describe, expect, it } from "vitest";

import {
  buildCreateBody,
  buildMcpServerFields,
  validateMcpServerDraft,
  type McpServerDraft,
} from "@/lib/mcp/mcp-form";

describe("validateMcpServerDraft (T-C2)", () => {
  it("accepts a valid stdio MCP server", () => {
    const r = validateMcpServerDraft({
      id: "github",
      transport: "stdio",
      command: "github-mcp",
      envKeys: ["env:GITHUB_TOKEN"],
    });

    expect(r.ok).toBe(true);
  });

  it("accepts a valid http MCP server", () => {
    const r = validateMcpServerDraft({
      id: "remote",
      transport: "http",
      url: "https://mcp.example.com/sse",
      headerKeys: ["env:MCP_AUTH"],
    });

    expect(r.ok).toBe(true);
  });

  it("rejects an stdio server with no command", () => {
    const r = validateMcpServerDraft({ id: "bad", transport: "stdio" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "command")).toBe(true);
  });

  it("rejects an sse/http server with no url", () => {
    const r = validateMcpServerDraft({ id: "bad", transport: "sse" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "url")).toBe(true);
  });

  it("rejects a bad id", () => {
    const r = validateMcpServerDraft({
      id: "bad id!",
      transport: "stdio",
      command: "x",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "id")).toBe(true);
  });

  it("rejects an unknown transport", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "grpc" as unknown as McpServerDraft["transport"],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "transport")).toBe(true);
  });

  it("rejects an invalid env key reference (no plaintext)", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      envKeys: ["sk-plaintext-secret-value"],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "envKeys")).toBe(true);
  });

  it("rejects an empty supportedAgents list", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      supportedAgents: [],
    });

    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => e.field === "supportedAgents")).toBe(true);
  });
});

describe("buildMcpServerFields (T-C2)", () => {
  it("normalizes off-transport fields away for stdio", () => {
    const f = buildMcpServerFields({
      id: "x",
      transport: "stdio",
      command: "run",
      args: ["--flag"],
      envKeys: ["env:T"],
      url: "https://leftover.example.com",
      headerKeys: ["env:LEFTOVER"],
    });

    expect(f.command).toBe("run");
    expect(f.args).toEqual(["--flag"]);
    expect(f.url).toBeNull();
    expect(f.headerKeys).toEqual([]);
  });

  it("normalizes off-transport fields away for http", () => {
    const f = buildMcpServerFields({
      id: "x",
      transport: "http",
      url: "https://mcp.example.com",
      headerKeys: ["env:AUTH"],
      command: "leftover",
      args: ["--leftover"],
      envKeys: ["env:LEFTOVER"],
    });

    expect(f.url).toBe("https://mcp.example.com");
    expect(f.headerKeys).toEqual(["env:AUTH"]);
    expect(f.command).toBeNull();
    expect(f.args).toEqual([]);
    expect(f.envKeys).toEqual([]);
  });

  it("buildCreateBody carries the id + defaults agents/enabled", () => {
    const b = buildCreateBody({
      id: "github",
      transport: "stdio",
      command: "x",
    });

    expect(b.id).toBe("github");
    expect(b.supportedAgents).toEqual(["claude", "codex"]);
    expect(b.enabled).toBe(true);
  });
});
