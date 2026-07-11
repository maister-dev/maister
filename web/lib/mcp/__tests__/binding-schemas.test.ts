import { describe, expect, it } from "vitest";

import {
  connectSchema,
  createBindingSchema,
  mcpConfigOverlaySchema,
  patchBindingSchema,
} from "@/lib/mcp/binding-schemas";

// ADR-129 (DEC-1): the binding-route wire contract. `.strict()` means a body can
// never smuggle a server-state field (e.g. project), and overlay remap values
// must be env:NAME — the untouchable secret invariant enforced at the boundary.

describe("createBindingSchema", () => {
  it("accepts a minimal bind", () => {
    expect(
      createBindingSchema.parse({
        refId: "github",
        targetKind: "platform",
        targetId: "gh-1",
      }),
    ).toMatchObject({ refId: "github", targetKind: "platform" });
  });

  it("rejects an unknown/server-state field in the body (strict — no project locator)", () => {
    expect(() =>
      createBindingSchema.parse({
        refId: "github",
        targetKind: "platform",
        targetId: "gh-1",
        projectId: "smuggled",
      }),
    ).toThrow();
  });

  it("rejects a missing targetKind and an invalid targetKind", () => {
    expect(() =>
      createBindingSchema.parse({ refId: "x", targetId: "y" }),
    ).toThrow();
    expect(() =>
      createBindingSchema.parse({
        refId: "x",
        targetKind: "bogus",
        targetId: "y",
      }),
    ).toThrow();
  });
});

describe("mcpConfigOverlaySchema", () => {
  it("rejects a raw (non-env:) remap value", () => {
    expect(() =>
      mcpConfigOverlaySchema.parse({ envRemap: { TOKEN: "raw-value" } }),
    ).toThrow();
  });

  it("accepts env:NAME remaps and non-secret arg/url overrides", () => {
    expect(
      mcpConfigOverlaySchema.parse({
        envRemap: { TOKEN: "env:PROJ_A" },
        argsOverride: ["--x"],
        urlOverride: "https://p.example/mcp",
      }),
    ).toMatchObject({ envRemap: { TOKEN: "env:PROJ_A" } });
  });
});

describe("patchBindingSchema", () => {
  it("rejects an empty patch (minProperties refine)", () => {
    expect(() => patchBindingSchema.parse({})).toThrow();
  });

  it("accepts a single-field toggle", () => {
    expect(patchBindingSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });
});

describe("connectSchema", () => {
  it("requires platformServerId", () => {
    expect(() => connectSchema.parse({ refId: "github" })).toThrow();
    expect(connectSchema.parse({ platformServerId: "gh-1" })).toMatchObject({
      platformServerId: "gh-1",
    });
  });
});
