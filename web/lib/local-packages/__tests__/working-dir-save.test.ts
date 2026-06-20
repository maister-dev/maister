import { describe, expect, it } from "vitest";

import {
  overlayFlowBuffer,
  parsePackageFilesJson,
  planWorkingDirWrites,
} from "@/lib/local-packages/working-dir-save";

describe("planWorkingDirWrites", () => {
  it("PUTs new and changed files, skips unchanged", () => {
    const original = [
      { path: "flow.yaml", content: "a" },
      { path: "skills/x.md", content: "keep" },
    ];
    const submitted = [
      { path: "flow.yaml", content: "a2" }, // changed
      { path: "skills/x.md", content: "keep" }, // unchanged → skip
      { path: "rules/r.md", content: "new" }, // added
    ];

    expect(planWorkingDirWrites(original, submitted)).toEqual([
      { op: "put", path: "flow.yaml", content: "a2" },
      { op: "put", path: "rules/r.md", content: "new" },
    ]);
  });

  it("DELETEs files dropped from the submitted set", () => {
    const original = [
      { path: "flow.yaml", content: "a" },
      { path: "skills/gone.md", content: "x" },
    ];
    const submitted = [{ path: "flow.yaml", content: "a" }];

    expect(planWorkingDirWrites(original, submitted)).toEqual([
      { op: "delete", path: "skills/gone.md" },
    ]);
  });

  it("is a no-op when nothing changed", () => {
    const files = [{ path: "flow.yaml", content: "a" }];

    expect(planWorkingDirWrites(files, files)).toEqual([]);
  });
});

describe("overlayFlowBuffer", () => {
  it("replaces the selected flow path with the canvas buffer", () => {
    const submitted = [
      { path: "flow.yaml", content: "stale" },
      { path: "skills/x.md", content: "keep" },
    ];

    expect(overlayFlowBuffer(submitted, "flow.yaml", "fresh")).toEqual([
      { path: "flow.yaml", content: "fresh" },
      { path: "skills/x.md", content: "keep" },
    ]);
  });

  it("appends the flow buffer when the path is not in the set", () => {
    expect(overlayFlowBuffer([], "flows/new.yaml", "body")).toEqual([
      { path: "flows/new.yaml", content: "body" },
    ]);
  });

  it("returns the set unchanged when no flow path is selected", () => {
    const submitted = [{ path: "a.md", content: "x" }];

    expect(overlayFlowBuffer(submitted, null, "ignored")).toEqual(submitted);
  });
});

describe("parsePackageFilesJson", () => {
  const fallback = [{ kind: "asset" as const, path: "a.md", content: "x" }];

  it("parses a valid blob", () => {
    const raw = JSON.stringify([{ path: "b.md", content: "y", kind: "asset" }]);

    expect(parsePackageFilesJson(raw, fallback)).toEqual([
      { path: "b.md", content: "y" },
    ]);
  });

  it("falls back to originals on malformed / absent input", () => {
    expect(parsePackageFilesJson(null, fallback)).toEqual([
      { path: "a.md", content: "x" },
    ]);
    expect(parsePackageFilesJson("not json", fallback)).toEqual([
      { path: "a.md", content: "x" },
    ]);
    expect(parsePackageFilesJson("{}", fallback)).toEqual([
      { path: "a.md", content: "x" },
    ]);
  });

  it("drops malformed entries", () => {
    const raw = JSON.stringify([
      { path: "ok.md", content: "z" },
      { path: 5, content: "bad" },
      { content: "no-path" },
    ]);

    expect(parsePackageFilesJson(raw, fallback)).toEqual([
      { path: "ok.md", content: "z" },
    ]);
  });
});
