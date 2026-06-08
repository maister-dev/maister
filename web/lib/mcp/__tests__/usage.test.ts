import { describe, expect, it } from "vitest";

import { collectMcpUsageReferences } from "@/lib/mcp/usage";

const base = {
  id: "cap-1",
  projectId: "prj-1",
  kind: "mcp",
  source: "platform",
  capabilityRefId: "github",
  disabledAt: null as Date | null,
};

describe("collectMcpUsageReferences (T-C1)", () => {
  it("counts a live platform mcp materialization as a reference", () => {
    const refs = collectMcpUsageReferences({
      mcpId: "github",
      capabilityRecords: [base],
    });

    expect(refs).toEqual([
      {
        kind: "projectMaterialization",
        projectId: "prj-1",
        recordId: "cap-1",
        mcpId: "github",
      },
    ]);
  });

  it("ignores records for a different mcp id", () => {
    const refs = collectMcpUsageReferences({
      mcpId: "github",
      capabilityRecords: [{ ...base, capabilityRefId: "slack" }],
    });

    expect(refs).toEqual([]);
  });

  it("ignores non-mcp kinds and non-platform sources", () => {
    const refs = collectMcpUsageReferences({
      mcpId: "github",
      capabilityRecords: [
        { ...base, id: "a", kind: "skill" },
        { ...base, id: "b", source: "project" },
        { ...base, id: "c", source: "flow-package" },
      ],
    });

    expect(refs).toEqual([]);
  });

  it("ignores soft-disabled materializations", () => {
    const refs = collectMcpUsageReferences({
      mcpId: "github",
      capabilityRecords: [{ ...base, disabledAt: new Date(1) }],
    });

    expect(refs).toEqual([]);
  });
});
