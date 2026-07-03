import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ChunkerError,
  createBuiltInChunkerRegistry,
  type BrainChunkDraft,
} from "@/lib/brain/chunkers/registry";

const FIXTURE_DIR = join(process.cwd(), "lib/brain/__fixtures__/sources");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function expectClosedChunkShape(chunk: BrainChunkDraft): void {
  expect(Object.keys(chunk).sort()).toEqual([
    "content",
    "kind",
    "metadata",
    "path",
    "sourceRange",
    "stableId",
    "symbol",
    "title",
  ]);
}

describe("ChunkerRegistry (ADR-127)", () => {
  it.each([
    ["sample.ts", "code_symbol"],
    ["sample.py", "code_symbol"],
    ["sample.md", "markdown_section"],
    ["openapi.yaml", "openapi_operation"],
    ["asyncapi.yaml", "asyncapi_operation"],
    ["schema.sql", "sql_statement"],
    ["flow.yaml", "flow_node"],
    ["maister-package.yaml", "package_entry"],
    ["agent.md", "agent_doc"],
  ])("chunks %s into the closed shape", (path, expectedKind) => {
    const registry = createBuiltInChunkerRegistry();
    const result = registry.chunk({ path, content: fixture(path) });

    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.chunks[0]?.kind).toBe(expectedKind);
    expectClosedChunkShape(result.chunks[0]!);
  });

  it("produces stable ids for identical re-chunks", () => {
    const registry = createBuiltInChunkerRegistry();
    const first = registry.chunk({
      path: "sample.md",
      content: fixture("sample.md"),
    });
    const second = registry.chunk({
      path: "sample.md",
      content: fixture("sample.md"),
    });

    expect(first.chunks.map((chunk) => chunk.stableId)).toEqual(
      second.chunks.map((chunk) => chunk.stableId),
    );
  });

  it("normalizes HTML into markdown chunks through the markdown chunker id", () => {
    const registry = createBuiltInChunkerRegistry();
    const result = registry.chunk({
      path: "sample.html",
      content: fixture("sample.html"),
    });

    expect(result.chunkerId).toBe("markdown");
    expect(result.chunks[0]?.kind).toBe("markdown_section");
    expect(result.chunks[0]?.content).toContain("# Project Brain");
    expect(result.chunks[0]?.content).not.toContain("<article>");
  });

  it("falls back for unknown text while recording the fallback chunker id", () => {
    const registry = createBuiltInChunkerRegistry();
    const result = registry.chunk({
      path: "fallback.unknown",
      content: fixture("fallback.txt"),
    });

    expect(result.chunkerId).toBe("fallback_text");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.metadata).toMatchObject({
      fallback: true,
    });
  });

  it("raises typed source-scoped parser errors", () => {
    const registry = createBuiltInChunkerRegistry();

    expect(() =>
      registry.chunk({
        path: "broken.openapi.yaml",
        kind: "openapi",
        content: "openapi: 3.0.3\npaths: [",
      }),
    ).toThrow(ChunkerError);

    try {
      registry.chunk({
        path: "broken.openapi.yaml",
        kind: "openapi",
        content: "openapi: 3.0.3\npaths: [",
      });
    } catch (error) {
      expect(error).toMatchObject({
        sourcePath: "broken.openapi.yaml",
        chunkerId: "openapi",
      });
    }
  });
});
