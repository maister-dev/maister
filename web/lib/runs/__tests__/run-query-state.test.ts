import { describe, expect, it } from "vitest";

import {
  buildRunDiffFileHref,
  buildRunFileHref,
  buildRunHref,
  buildRunSearchParams,
  parseRunQueryState,
} from "@/lib/runs/run-query-state";

describe("run-query-state", () => {
  it("parses valid query state", () => {
    const state = parseRunQueryState(
      "wb=diff&diffFile=src%2Fa.ts&diffview=unified&diffbody=raw&scope=last-node&node=n1&inspector=closed&flow=fullscreen",
    );

    expect(state).toEqual({
      workbench: "diff",
      file: null,
      fileView: "preview",
      diffFile: "src/a.ts",
      diffView: "unified",
      diffBody: "raw",
      scope: "last-node",
      node: "n1",
      inspector: "closed",
      flow: "fullscreen",
    });
  });

  it("falls back on invalid enum values without dropping unrelated params", () => {
    const state = parseRunQueryState(
      "wb=graph&file=README.md&fileView=render&diffview=sideways&scope=bad&inspector=pinned",
    );

    expect(state).toMatchObject({
      workbench: "timeline",
      file: "README.md",
      fileView: "preview",
      diffView: "split",
      diffBody: "rich",
      scope: "run",
      inspector: null,
    });
  });

  it("preserves unrelated params when patching the active workbench tab", () => {
    const params = buildRunSearchParams("node=review&scope=uncommitted", {
      wb: "timeline",
    });

    expect(params.toString()).toBe("node=review&scope=uncommitted&wb=timeline");
  });

  it("patches the diff body mode", () => {
    const href = buildRunHref("/runs/run-1", "wb=diff&diffbody=rich", {
      diffbody: "raw",
    });

    expect(href).toBe("/runs/run-1?wb=diff&diffbody=raw");
  });

  it("uses file only for the Files pane", () => {
    const href = buildRunFileHref(
      "/runs/run-1",
      "wb=diff&diffFile=src%2Fold.ts&scope=run",
      "src/new.ts",
    );

    expect(href).toBe(
      "/runs/run-1?wb=files&diffFile=src%2Fold.ts&scope=run&file=src%2Fnew.ts&fileView=source",
    );
  });

  it("uses diffFile only for the Diff pane", () => {
    const href = buildRunDiffFileHref(
      "/runs/run-1",
      "wb=files&file=README.md&fileView=source&scope=run",
      "src/app.ts",
    );

    expect(href).toBe(
      "/runs/run-1?wb=diff&file=README.md&fileView=source&scope=run&diffFile=src%2Fapp.ts",
    );
  });

  it("removes params when a null patch value is provided", () => {
    const href = buildRunHref("/runs/run-1", "wb=diff&diffFile=src%2Fa.ts", {
      diffFile: null,
      wb: "evidence",
    });

    expect(href).toBe("/runs/run-1?wb=evidence");
  });
});
