import { describe, expect, it } from "vitest";

import {
  newSubagentTemplate,
  subagentFrontmatterSchema,
  validateSubagentMarkdown,
} from "@/lib/agents/subagent-definition";

describe("subagent-definition (M39 A4)", () => {
  it("accepts name + description and PRESERVES custom keys (lenient + open)", () => {
    const result = subagentFrontmatterSchema.safeParse({
      name: "rev",
      description: "reviews",
      tools: "Read, Bash",
      model: "inherit",
      color: "blue",
      custom: { anything: true },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // passthrough keeps the unknown key
      expect((result.data as Record<string, unknown>).custom).toBeDefined();
    }
  });

  it("accepts tools as a list too", () => {
    expect(
      subagentFrontmatterSchema.safeParse({
        name: "rev",
        description: "d",
        tools: ["Read", "Bash"],
      }).success,
    ).toBe(true);
  });

  it("rejects missing name or description", () => {
    expect(subagentFrontmatterSchema.safeParse({ name: "x" }).success).toBe(
      false,
    );
    expect(
      subagentFrontmatterSchema.safeParse({ description: "x" }).success,
    ).toBe(false);
  });

  it("validateSubagentMarkdown flags missing frontmatter, passes a valid doc", () => {
    expect(validateSubagentMarkdown("just a body\n").length).toBeGreaterThan(0);
    expect(
      validateSubagentMarkdown("---\nname: a\ndescription: b\n---\nbody\n"),
    ).toEqual([]);
  });

  it("newSubagentTemplate seeds model: inherit and omits tools", () => {
    const tpl = newSubagentTemplate("rev");

    expect(tpl).toContain("name: rev");
    expect(tpl).toContain("model: inherit");
    expect(tpl).not.toContain("tools:");
  });
});
