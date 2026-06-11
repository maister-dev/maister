import { describe, expect, it } from "vitest";

import {
  agentFrontmatterSchema,
  ruleGuardrailSchema,
  serializeFrontmatter,
  skillFrontmatterSchema,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";

describe("splitFrontmatter", () => {
  it("parses a leading --- fenced yaml block into frontmatter + body", () => {
    const content =
      "---\nname: demo\ndescription: A demo skill\n---\n# Body\n\ntext\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter).toEqual({
      name: "demo",
      description: "A demo skill",
    });
    expect(result.body).toBe("# Body\n\ntext\n");
    expect(result.raw).toBe(content);
  });

  it("returns frontmatter undefined and body=content when there is no fence", () => {
    const content = "# Just markdown\n\nno frontmatter here\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter).toBeUndefined();
    expect(result.body).toBe(content);
    expect(result.raw).toBe(content);
  });

  it("does NOT treat a horizontal rule mid-document as frontmatter", () => {
    const content = "# Heading\n\nsome intro\n\n---\n\nmore body\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter).toBeUndefined();
    expect(result.body).toBe(content);
  });

  it("signals malformed distinctly when the fenced yaml fails to parse", () => {
    const content = "---\nname: demo\n  bad: : indent\n:::oops\n---\nbody\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.malformed).toBe(true);
    expect(result.raw).toBe(content);
    expect(typeof result.reason).toBe("string");
  });

  it("signals malformed when the opening fence has no closing fence", () => {
    const content = "---\nname: demo\ndescription: x\nbody with no close\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.malformed).toBe(true);
  });

  it("signals malformed when the fenced block parses to a non-object scalar", () => {
    const content = "---\njust a string\n---\nbody\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.malformed).toBe(true);
  });

  it("treats an empty fenced block as frontmatter undefined (no fields)", () => {
    const content = "---\n---\nbody\n";
    const result = splitFrontmatter(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frontmatter).toBeUndefined();
    expect(result.body).toBe("body\n");
  });
});

describe("serializeFrontmatter", () => {
  it("re-emits a ---fenced yaml block followed by the body", () => {
    const out = serializeFrontmatter({
      frontmatter: { name: "demo", description: "A demo skill" },
      body: "# Body\n",
    });

    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("name: demo");
    expect(out).toContain("description: A demo skill");
    expect(out).toContain("\n---\n# Body\n");
  });

  it("emits body only (no fence) when frontmatter is undefined", () => {
    const out = serializeFrontmatter({
      frontmatter: undefined,
      body: "# Body\n",
    });

    expect(out).toBe("# Body\n");
  });
});

describe("split → serialize round-trip byte-stability", () => {
  it("is byte-stable for an untouched document with unknown keys", () => {
    const content =
      "---\nname: demo\ndescription: A demo skill\nargument-hint: <path>\nallowed-tools:\n  - Read\n  - Edit\ncustom-vendor-key: keep-me\n---\n# Heading\n\nbody paragraph\n";

    const split = splitFrontmatter(content);

    expect(split.ok).toBe(true);
    if (!split.ok) return;

    const round = serializeFrontmatter({
      frontmatter: split.frontmatter,
      body: split.body,
    });
    const reparsed = splitFrontmatter(round);

    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;

    // Re-emitting an untouched doc returns equivalent content: a second
    // split→serialize is a fixed point, and every key (incl. the unknown
    // vendor key) survives.
    expect(
      serializeFrontmatter({
        frontmatter: reparsed.frontmatter,
        body: reparsed.body,
      }),
    ).toBe(round);
    expect(reparsed.frontmatter).toEqual(split.frontmatter);
    expect(reparsed.body).toBe(split.body);
    expect(
      (split.frontmatter as Record<string, unknown>)["custom-vendor-key"],
    ).toBe("keep-me");
  });

  it("preserves the body verbatim across the round-trip", () => {
    const content =
      "---\nname: x\ndescription: y\n---\nline 1\n\n  indented\nline 3\n";
    const split = splitFrontmatter(content);

    if (!split.ok) return;

    const round = serializeFrontmatter({
      frontmatter: split.frontmatter,
      body: split.body,
    });
    const reparsed = splitFrontmatter(round);

    if (!reparsed.ok) return;
    expect(reparsed.body).toBe("line 1\n\n  indented\nline 3\n");
  });
});

describe("skillFrontmatterSchema", () => {
  it("accepts name + description and keeps unknown keys (passthrough)", () => {
    const parsed = skillFrontmatterSchema.parse({
      name: "demo",
      description: "A demo skill",
      "argument-hint": "<path>",
      "allowed-tools": ["Read", "Edit"],
      "disable-model-invocation": true,
      model: "claude-sonnet-4-6",
      "vendor-extra": { nested: 1 },
    });

    expect(parsed.name).toBe("demo");
    expect((parsed as Record<string, unknown>)["vendor-extra"]).toEqual({
      nested: 1,
    });
    expect((parsed as Record<string, unknown>)["argument-hint"]).toBe("<path>");
  });

  it("rejects a missing description", () => {
    expect(skillFrontmatterSchema.safeParse({ name: "demo" }).success).toBe(
      false,
    );
  });

  it("rejects a missing name", () => {
    expect(skillFrontmatterSchema.safeParse({ description: "x" }).success).toBe(
      false,
    );
  });

  it("rejects an empty name", () => {
    expect(
      skillFrontmatterSchema.safeParse({ name: "", description: "x" }).success,
    ).toBe(false);
  });
});

describe("agentFrontmatterSchema", () => {
  it("accepts name + description and keeps unknown keys (passthrough)", () => {
    const parsed = agentFrontmatterSchema.parse({
      name: "reviewer",
      description: "Reviews code",
      tools: "Read, Edit",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      maxTurns: 12,
      "vendor-extra": "keep",
    });

    expect(parsed.name).toBe("reviewer");
    expect(parsed.maxTurns).toBe(12);
    expect((parsed as Record<string, unknown>)["vendor-extra"]).toBe("keep");
  });

  it("rejects a missing description", () => {
    expect(agentFrontmatterSchema.safeParse({ name: "reviewer" }).success).toBe(
      false,
    );
  });

  it("rejects a missing name", () => {
    expect(agentFrontmatterSchema.safeParse({ description: "x" }).success).toBe(
      false,
    );
  });
});

describe("ruleGuardrailSchema", () => {
  it("accepts an all-absent object", () => {
    const parsed = ruleGuardrailSchema.parse({});

    expect(parsed).toEqual({});
  });

  it("accepts the full guardrail shape and keeps unknown keys", () => {
    const parsed = ruleGuardrailSchema.parse({
      allowed_paths: ["src/**"],
      forbidden_paths: ["secrets/**"],
      allowed_commands: ["pnpm test"],
      require_structured_response: true,
      "vendor-extra": 1,
    });

    expect(parsed.allowed_paths).toEqual(["src/**"]);
    expect(parsed.require_structured_response).toBe(true);
    expect((parsed as Record<string, unknown>)["vendor-extra"]).toBe(1);
  });

  it("rejects allowed_paths that is not an array of strings", () => {
    expect(
      ruleGuardrailSchema.safeParse({ allowed_paths: "src/**" }).success,
    ).toBe(false);
  });

  it("rejects require_structured_response that is not a boolean", () => {
    expect(
      ruleGuardrailSchema.safeParse({ require_structured_response: "yes" })
        .success,
    ).toBe(false);
  });
});
