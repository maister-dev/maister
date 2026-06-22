import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";

import { describe, expect, it } from "vitest";

import { buildRunningCommandCatalog } from "@/lib/capabilities/running-catalog";

const staticCatalog: ProjectCapabilityCatalogEntry[] = [
  {
    kind: "skill",
    refId: "aif-plan",
    slug: "aif-plan",
    displayName: "AIF Plan",
    description: "Plan a feature",
    argHint: "<feature>",
    canonicalToken: "@skill:aif-plan",
    surfaceForm: "/aif-plan",
    supported: true,
  },
  {
    kind: "subagent",
    refId: "pkg:reviewer",
    slug: "reviewer",
    displayName: "Reviewer",
    description: "Reviews code",
    argHint: null,
    canonicalToken: "@agent:reviewer",
    surfaceForm: "@reviewer",
    supported: true,
  },
];

describe("buildRunningCommandCatalog — live ∪ subagents (FR-A3 / source #3)", () => {
  it("maps a codex live `$slug` to a canonical skill chip, enriched from the static catalog", () => {
    const out = buildRunningCommandCatalog(
      [{ name: "$aif-plan", description: null, hint: null }],
      staticCatalog,
      "codex",
    );
    const skill = out.find((e) => e.slug === "aif-plan");

    expect(skill).toMatchObject({
      kind: "skill",
      slug: "aif-plan",
      displayName: "AIF Plan",
      description: "Plan a feature",
      argHint: "<feature>",
      canonicalToken: "@skill:aif-plan",
      surfaceForm: "$aif-plan",
      supported: true,
    });
  });

  it("maps a claude bare live name to the `/slug` wire form, same canonical token", () => {
    const out = buildRunningCommandCatalog(
      [{ name: "aif-plan", description: null, hint: null }],
      staticCatalog,
      "claude",
    );
    const skill = out.find((e) => e.slug === "aif-plan");

    expect(skill?.surfaceForm).toBe("/aif-plan");
    expect(skill?.canonicalToken).toBe("@skill:aif-plan");
  });

  it("surfaces a native/built-in live command with no static match as a raw command", () => {
    const out = buildRunningCommandCatalog(
      [{ name: "compact", description: "Compact the context", hint: null }],
      staticCatalog,
      "claude",
    );

    expect(out.find((e) => e.slug === "compact")).toMatchObject({
      kind: "command",
      slug: "compact",
      displayName: "/compact",
      description: "Compact the context",
      canonicalToken: "/compact",
      surfaceForm: "/compact",
      supported: true,
    });
  });

  it("keeps a codex `/` built-in as its exact raw command form (regression)", () => {
    // codex emits skills as `$slug` but native built-ins as `/status`. A built-in
    // is not a project skill → it must keep `/status`; serializing it as
    // `@skill:status` would normalize to `$status`, which codex does not
    // recognize.
    const out = buildRunningCommandCatalog(
      [
        { name: "/status", description: "Session status", hint: null },
        { name: "$aif-plan", description: null, hint: null },
      ],
      staticCatalog,
      "codex",
    );

    expect(out.find((e) => e.slug === "status")).toMatchObject({
      kind: "command",
      canonicalToken: "/status",
      surfaceForm: "/status",
    });
    expect(out.some((e) => e.surfaceForm === "$status")).toBe(false);
    // the real project skill still surfaces with the correct codex wire form
    expect(out.find((e) => e.slug === "aif-plan")?.surfaceForm).toBe(
      "$aif-plan",
    );
  });

  it("prefers the live description/hint over the static catalog values", () => {
    const out = buildRunningCommandCatalog(
      [{ name: "/aif-plan", description: "live desc", hint: "live hint" }],
      staticCatalog,
      "claude",
    );
    const skill = out.find((e) => e.slug === "aif-plan");

    expect(skill?.description).toBe("live desc");
    expect(skill?.argHint).toBe("live hint");
  });

  it("surfaces mcp: commands exactly as ACP emitted them", () => {
    const out = buildRunningCommandCatalog(
      [{ name: "mcp:github", description: null, hint: null }],
      staticCatalog,
      "claude",
    );

    expect(out.find((e) => e.slug === "mcp:github")).toMatchObject({
      kind: "command",
      canonicalToken: "mcp:github",
      surfaceForm: "mcp:github",
    });
  });

  it("dedupes the same project skill arriving via both sigils", () => {
    const out = buildRunningCommandCatalog(
      [
        { name: "$aif-plan", description: null, hint: null },
        { name: "aif-plan", description: null, hint: null },
      ],
      staticCatalog,
      "codex",
    );

    expect(out.filter((e) => e.slug === "aif-plan")).toHaveLength(1);
  });

  it("unions the static subagents (claude-only, never in the live stream)", () => {
    const out = buildRunningCommandCatalog([], staticCatalog, "claude");
    const sub = out.find((e) => e.kind === "subagent");

    expect(sub).toMatchObject({
      kind: "subagent",
      slug: "reviewer",
      canonicalToken: "@agent:reviewer",
      surfaceForm: "@reviewer",
    });
  });

  it("does NOT surface a static skill that is absent from the live stream", () => {
    // aif-plan is in the static catalog but not in the live list → not available.
    const out = buildRunningCommandCatalog([], staticCatalog, "claude");

    expect(out.some((e) => e.kind === "skill")).toBe(false);
  });

  it("does not carry codex subagents (static catalog for codex has none)", () => {
    const codexStatic = staticCatalog.filter((e) => e.kind === "skill");
    const out = buildRunningCommandCatalog(
      [{ name: "$aif-plan", description: null, hint: null }],
      codexStatic,
      "codex",
    );

    expect(out.some((e) => e.kind === "subagent")).toBe(false);
  });
});
