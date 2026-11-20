import { describe, expect, it } from "vitest";

import { commandAccessOverrideSchema } from "@/lib/runs/isolation-command-access";

describe("command access override", () => {
  it("distinguishes clear, inheritance and an explicit empty grant", () => {
    expect(commandAccessOverrideSchema.parse(null)).toBeNull();
    expect(commandAccessOverrideSchema.parse({})).toEqual({});
    expect(commandAccessOverrideSchema.parse({ hostPortGrants: [] })).toEqual({
      hostPortGrants: [],
    });
  });

  it.each([
    { approval: "auto_approve" },
    { credentials: ["provider"] },
    { hostPortGrants: ["db", "db"] },
    { readOnlyPathGrants: [""] },
    { network: { mode: "allowlist" } },
    { limits: { timeoutMs: 100 } },
    {
      limits: {
        timeoutMs: 100,
        memoryBytes: 1024,
        processes: 0,
        cpuMillicores: 100,
      },
    },
  ])("rejects invalid command overrides: %j", (override) => {
    expect(commandAccessOverrideSchema.safeParse(override).success).toBe(false);
  });
});
