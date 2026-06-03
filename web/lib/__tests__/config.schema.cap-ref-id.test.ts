/**
 * T2.0 — capabilityRefIdSchema: safe path-segment validation for capability ids.
 * Mirrors flowIdSchema from flow-paths.ts (wider max: 128 chars).
 */
import { describe, expect, it } from "vitest";

import {
  capabilityRefIdSchema,
  maisterCapabilitiesSchema,
} from "@/lib/config.schema";

describe("capabilityRefIdSchema", () => {
  it("accepts a normal kebab-case id", () => {
    expect(() => capabilityRefIdSchema.parse("my-mcp-server")).not.toThrow();
  });

  it("accepts alphanumeric with dots and underscores", () => {
    expect(() => capabilityRefIdSchema.parse("my_tool.v2-beta")).not.toThrow();
  });

  it("accepts a single character", () => {
    expect(() => capabilityRefIdSchema.parse("a")).not.toThrow();
  });

  it("accepts exactly 128 characters", () => {
    expect(() => capabilityRefIdSchema.parse("a".repeat(128))).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => capabilityRefIdSchema.parse("")).toThrow();
  });

  it("rejects string exceeding 128 characters", () => {
    expect(() => capabilityRefIdSchema.parse("a".repeat(129))).toThrow();
  });

  it("rejects '../evil' (path traversal)", () => {
    expect(() => capabilityRefIdSchema.parse("../evil")).toThrow();
  });

  it("rejects '..' sentinel", () => {
    expect(() => capabilityRefIdSchema.parse("..")).toThrow();
  });

  it("rejects '.' sentinel", () => {
    expect(() => capabilityRefIdSchema.parse(".")).toThrow();
  });

  it("rejects 'a/b' (forward slash)", () => {
    expect(() => capabilityRefIdSchema.parse("a/b")).toThrow();
  });

  it("rejects string containing '..' embedded", () => {
    expect(() => capabilityRefIdSchema.parse("a..b")).toThrow();
  });

  it("rejects string with spaces", () => {
    expect(() => capabilityRefIdSchema.parse("my tool")).toThrow();
  });
});

describe("maisterCapabilitiesSchema — id field uses capabilityRefIdSchema", () => {
  it("rejects capability with id '../evil'", () => {
    expect(() =>
      maisterCapabilitiesSchema.parse({
        mcps: [{ id: "../evil", command: "npx" }],
      }),
    ).toThrow();
  });

  it("rejects capability with id '..'", () => {
    expect(() =>
      maisterCapabilitiesSchema.parse({
        skills: [{ id: ".." }],
      }),
    ).toThrow();
  });

  it("rejects capability with id 'a/b'", () => {
    expect(() =>
      maisterCapabilitiesSchema.parse({
        rules: [{ id: "a/b" }],
      }),
    ).toThrow();
  });

  it("rejects capability with id '.'", () => {
    expect(() =>
      maisterCapabilitiesSchema.parse({
        restrictions: [{ id: "." }],
      }),
    ).toThrow();
  });

  it("accepts a normal kebab-case capability id", () => {
    const result = maisterCapabilitiesSchema.parse({
      mcps: [{ id: "my-mcp-server" }],
    });

    expect(result.mcps[0].id).toBe("my-mcp-server");
  });

  it("accepts a capability id with dots and underscores", () => {
    const result = maisterCapabilitiesSchema.parse({
      skills: [{ id: "my_skill.v2" }],
    });

    expect(result.skills[0].id).toBe("my_skill.v2");
  });
});
