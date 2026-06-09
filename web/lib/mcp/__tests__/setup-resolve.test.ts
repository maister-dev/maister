import { describe, expect, it } from "vitest";

import { resolveRequiredMcps } from "@/lib/mcp/setup-resolve";

// M27/T-C7 (setup-resolve, ADR-069): setup-time classify each REQUIRED mcp ref
// id against the project's mcp capability records. "present" reuses the
// local-first winner per the SAME precedence as resolver.ts
// (project > platform > flow-package); "absent" → propose-to-configure. No
// silent duplicate: duplicate required ids collapse to one resolution.

function rec(over: {
  id?: string;
  capabilityRefId: string;
  source: "platform" | "project" | "flow-package";
}) {
  return {
    id: over.id ?? `row-${over.source ?? "platform"}-${over.capabilityRefId}`,
    capabilityRefId: over.capabilityRefId,
    source: over.source,
  };
}

describe("resolveRequiredMcps (T-C7 setup-resolve)", () => {
  it("marks an id present and carries its recordId + scope", () => {
    const resolutions = resolveRequiredMcps(
      ["github"],
      [rec({ id: "row-1", capabilityRefId: "github", source: "project" })],
    );

    expect(resolutions).toEqual([
      {
        refId: "github",
        status: "present",
        recordId: "row-1",
        scope: "project",
      },
    ]);
  });

  it("picks the local-first winner across scopes (project beats platform beats flow-package)", () => {
    const resolutions = resolveRequiredMcps(
      ["github"],
      [
        rec({
          id: "row-fp",
          capabilityRefId: "github",
          source: "flow-package",
        }),
        rec({ id: "row-pf", capabilityRefId: "github", source: "platform" }),
        rec({ id: "row-pj", capabilityRefId: "github", source: "project" }),
      ],
    );

    expect(resolutions).toEqual([
      {
        refId: "github",
        status: "present",
        recordId: "row-pj",
        scope: "project",
      },
    ]);
  });

  it("falls back to platform over flow-package when no project record", () => {
    const resolutions = resolveRequiredMcps(
      ["github"],
      [
        rec({
          id: "row-fp",
          capabilityRefId: "github",
          source: "flow-package",
        }),
        rec({ id: "row-pf", capabilityRefId: "github", source: "platform" }),
      ],
    );

    expect(resolutions).toEqual([
      {
        refId: "github",
        status: "present",
        recordId: "row-pf",
        scope: "platform",
      },
    ]);
  });

  it("marks an id absent when no mcp record exists for it", () => {
    const resolutions = resolveRequiredMcps(
      ["missing"],
      [rec({ capabilityRefId: "github", source: "project" })],
    );

    expect(resolutions).toEqual([{ refId: "missing", status: "absent" }]);
  });

  it("dedupes duplicate required ids to one resolution per id", () => {
    const resolutions = resolveRequiredMcps(
      ["github", "github", "missing", "missing"],
      [rec({ id: "row-1", capabilityRefId: "github", source: "project" })],
    );

    expect(resolutions).toEqual([
      {
        refId: "github",
        status: "present",
        recordId: "row-1",
        scope: "project",
      },
      { refId: "missing", status: "absent" },
    ]);
  });

  it("classifies a mix of present and absent ids, preserving first-seen order", () => {
    const resolutions = resolveRequiredMcps(
      ["absent-1", "github", "absent-2"],
      [rec({ id: "row-1", capabilityRefId: "github", source: "platform" })],
    );

    expect(resolutions).toEqual([
      { refId: "absent-1", status: "absent" },
      {
        refId: "github",
        status: "present",
        recordId: "row-1",
        scope: "platform",
      },
      { refId: "absent-2", status: "absent" },
    ]);
  });
});
