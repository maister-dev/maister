import { describe, expect, it } from "vitest";

import { packageManifestMcpSchema } from "@/lib/config.schema";

// ADR-129 (D3): a package manifest mcps[] entry with NEITHER command NOR url is
// a valid REQUIREMENT (id + env slots + description, no implementation). An
// entry WITH an implementation stays a template. Additive-optional → no
// schemaVersion bump. Adds optional recommendedPlatformServerId.

describe("packageManifestMcpSchema — requirement vs template (D3)", () => {
  it("accepts a requirement-only entry (id + env + description, no impl)", () => {
    const parsed = packageManifestMcpSchema.parse({
      id: "github",
      env: ["env:GITHUB_TOKEN"],
      description: "GitHub MCP required by this flow",
    });

    expect(parsed.id).toBe("github");
    expect(parsed.command).toBeUndefined();
    expect(parsed.url).toBeUndefined();
    expect(parsed.transport).toBeUndefined();
  });

  it("accepts an optional recommendedPlatformServerId hint", () => {
    const parsed = packageManifestMcpSchema.parse({
      id: "github",
      recommendedPlatformServerId: "github",
    });

    expect(parsed.recommendedPlatformServerId).toBe("github");
  });

  it("still accepts a stdio template with a command", () => {
    const parsed = packageManifestMcpSchema.parse({
      id: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });

    expect(parsed.transport).toBe("stdio");
    expect(parsed.command).toBe("npx");
  });

  it("still accepts an http template with a url", () => {
    const parsed = packageManifestMcpSchema.parse({
      id: "remote",
      transport: "http",
      url: "https://mcp.example/sse",
    });

    expect(parsed.url).toBe("https://mcp.example/sse");
  });

  it("rejects a template that declares transport:stdio without a command", () => {
    expect(() =>
      packageManifestMcpSchema.parse({ id: "fs", transport: "stdio" }),
    ).toThrow();
  });

  it("rejects args on a requirement-only entry (no transport/command)", () => {
    expect(() =>
      packageManifestMcpSchema.parse({ id: "fs", args: ["-y"] }),
    ).toThrow();
  });

  it("rejects a raw (non-env:) secret in env", () => {
    expect(() =>
      packageManifestMcpSchema.parse({ id: "x", env: ["RAW_VALUE"] }),
    ).toThrow();
  });
});
