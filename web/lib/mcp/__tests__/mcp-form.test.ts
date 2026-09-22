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
      env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
    });

    expect(r.ok).toBe(true);
  });

  it("accepts a valid http MCP server", () => {
    const r = validateMcpServerDraft({
      id: "remote",
      transport: "http",
      url: "https://mcp.example.com/sse",
      headers: { "X-Api-Key": "env:MCP_AUTH" },
      bearerTokenEnv: "env:MCP_TOKEN",
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

  it("ACCEPTS a literal value — the secret guard is a UI warning (D9)", () => {
    // This replaces the pre-ADR-179 "rejects plaintext" case, which is obsolete:
    // a literal is the operator's declaration that the value is not a secret.
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      env: { GITHUB_TOKEN: "ghp_literal", FASTMCP_LOG_LEVEL: "ERROR" },
    });

    expect(r.ok).toBe(true);
  });

  // WIRING only — the grammar table itself is asserted once, in
  // value-grammar.test.ts.
  it("rejects a malformed env: value, naming the offending key", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      env: { GH: "env:1BAD" },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "env.GH")).toBe(true);
  });

  it("rejects a literal header value carrying CR/LF", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "http",
      url: "https://mcp.example.com",
      headers: {
        "X-Tenant": `a${String.fromCharCode(13)}${String.fromCharCode(10)}X: 1`,
      },
    });

    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => e.field === "headers.X-Tenant")).toBe(true);
  });

  it("rejects a row whose value has no key", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      env: { "": "orphan" },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "env.")).toBe(true);
  });

  it("accepts a key with an EMPTY value as an empty literal", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      env: { OPTIONAL_FLAG: "" },
    });

    expect(r.ok).toBe(true);
  });

  it("accepts bearerTokenEnv on http and refuses it beside an Authorization row", () => {
    expect(
      validateMcpServerDraft({
        id: "x",
        transport: "http",
        url: "https://mcp.example.com",
        bearerTokenEnv: "env:MCP_TOKEN",
      }).ok,
    ).toBe(true);

    const conflict = validateMcpServerDraft({
      id: "x",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { authorization: "Basic abc" },
      bearerTokenEnv: "env:MCP_TOKEN",
    });

    expect(conflict.ok).toBe(false);
    if (!conflict.ok)
      expect(conflict.errors.some((e) => e.field === "bearerTokenEnv")).toBe(
        true,
      );
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

  it("accepts Gemini, OpenCode, and MiMo supported agents", () => {
    const r = validateMcpServerDraft({
      id: "x",
      transport: "stdio",
      command: "x",
      supportedAgents: ["gemini", "opencode", "mimo"],
    });

    expect(r.ok).toBe(true);
  });
});

describe("buildMcpServerFields (T-C2)", () => {
  it("normalizes off-transport fields away for stdio", () => {
    const f = buildMcpServerFields({
      id: "x",
      transport: "stdio",
      command: "run",
      args: ["--flag"],
      env: { T: "env:T" },
      url: "https://leftover.example.com",
      headers: { "X-Leftover": "env:LEFTOVER" },
      bearerTokenEnv: "env:LEFTOVER_TOKEN",
    });

    expect(f.command).toBe("run");
    expect(f.args).toEqual(["--flag"]);
    expect(f.env).toEqual({ T: "env:T" });
    expect(f.url).toBeNull();
    expect(f.headers).toEqual({});
    expect(f.bearerTokenEnv).toBeNull();
  });

  it("normalizes off-transport fields away for http", () => {
    const f = buildMcpServerFields({
      id: "x",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { "X-Api-Key": "env:AUTH" },
      bearerTokenEnv: "env:MCP_TOKEN",
      command: "leftover",
      args: ["--leftover"],
      env: { LEFTOVER: "env:LEFTOVER" },
    });

    expect(f.url).toBe("https://mcp.example.com");
    expect(f.headers).toEqual({ "X-Api-Key": "env:AUTH" });
    expect(f.bearerTokenEnv).toBe("env:MCP_TOKEN");
    expect(f.command).toBeNull();
    expect(f.args).toEqual([]);
    expect(f.env).toEqual({});
  });

  it("buildCreateBody carries the id + defaults agents/enabled", () => {
    const b = buildCreateBody({
      id: "github",
      transport: "stdio",
      command: "x",
    });

    expect(b.id).toBe("github");
    expect(b.supportedAgents).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ]);
    expect(b.enabled).toBe(true);
  });
});
