import { describe, expect, it } from "vitest";

import {
  flowYamlDiagnostics,
  jsonDiagnostics,
} from "@/lib/flows/authored-lint";

// A manifest that PARSES as YAML and PASSES flowYamlV1Schema — schemaVersion +
// name + exactly one of nodes[]/steps[]. Verified against the real
// flowYamlV1Schema (lib/config.schema.ts:669) in a throwaway probe.
function validFlowYaml(): string {
  return [
    "schemaVersion: 1",
    'name: "release-review"',
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    "      prompt: Plan",
    "    transitions:",
    "      success: done",
    "",
  ].join("\n");
}

// Maps a char offset back to a 1-based line number over `text` — used to assert
// a parse-error diagnostic lands on the offending source line without coupling
// the test to the exact column arithmetic of the production mapper.
function lineAtOffset(text: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }

  return line;
}

describe("flowYamlDiagnostics", () => {
  it("maps a YAML syntax error to a single diagnostic on the offending line", () => {
    // BAD_INDENT on line 3 — yaml reports linePos [{line:3,col:1},{line:3,col:2}]
    // (1-based). The production mapper converts that to a char offset over the
    // text; we assert the offset resolves back into line 3.
    const text = "a:\n b: [\n";
    const diagnostics = flowYamlDiagnostics(text);

    expect(diagnostics).toHaveLength(1);

    const [diagnostic] = diagnostics;

    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.message.length).toBeGreaterThan(0);
    // Parse errors carry a precise marker, not a file-level (0..len) span.
    expect(diagnostic.from).toBeGreaterThan(0);
    expect(diagnostic.to).toBeGreaterThanOrEqual(diagnostic.from);
    expect(lineAtOffset(text, diagnostic.from)).toBe(3);
  });

  it("emits file-level diagnostics for valid YAML that fails the manifest schema", () => {
    // Parses fine; fails flowYamlV1Schema (missing schemaVersion literal + name).
    const text = "foo: bar\n";
    const diagnostics = flowYamlDiagnostics(text);

    expect(diagnostics.length).toBeGreaterThanOrEqual(1);

    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.from).toBe(0);
      expect(diagnostic.to).toBe(text.length);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }

    // The zod issue path must surface in the message so the author can locate
    // the offending key (e.g. "name" / "schemaVersion").
    const combined = diagnostics.map((d) => d.message).join("\n");

    expect(combined).toMatch(/name|schemaVersion/);
  });

  it("returns no diagnostics for a valid flow.yaml manifest", () => {
    expect(flowYamlDiagnostics(validFlowYaml())).toEqual([]);
  });
});

describe("jsonDiagnostics", () => {
  it("flags malformed JSON", () => {
    expect(jsonDiagnostics("{bad").length).toBeGreaterThanOrEqual(1);

    const [diagnostic] = jsonDiagnostics("{bad");

    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.message.length).toBeGreaterThan(0);
    expect(diagnostic.to).toBeGreaterThanOrEqual(diagnostic.from);
  });

  it("returns no diagnostics for valid JSON", () => {
    expect(jsonDiagnostics('{"a":1}')).toEqual([]);
  });
});
