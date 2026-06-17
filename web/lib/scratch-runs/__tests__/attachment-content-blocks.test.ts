import type { StoredScratchAttachment } from "@/lib/scratch-runs/types";

import { describe, expect, it } from "vitest";

import { scratchPromptContentBlocks } from "@/lib/scratch-runs/attachments";

function stored(
  over: Partial<StoredScratchAttachment> &
    Pick<StoredScratchAttachment, "kind" | "value">,
): StoredScratchAttachment {
  return {
    label: null,
    fileName: null,
    mimeType: null,
    byteSize: null,
    sha256: null,
    storagePath: null,
    ...over,
  };
}

describe("scratchPromptContentBlocks — attachments → resource_link blocks (T5.4 B)", () => {
  it("returns undefined when there are no file attachments (string path)", () => {
    expect(scratchPromptContentBlocks("hello", [])).toBeUndefined();
    expect(
      scratchPromptContentBlocks("hello", [
        stored({ kind: "text_note", value: "a note", label: "note" }),
        stored({ kind: "issue_url", value: "https://x/1" }),
      ]),
    ).toBeUndefined();
  });

  it("emits a leading text block then a resource_link for an uploaded file", () => {
    const blocks = scratchPromptContentBlocks("review this", [
      stored({
        kind: "uploaded_file",
        value: ".maister/demo/runs/r1/uploads/m1/notes.txt",
        fileName: "notes.txt",
        mimeType: "text/plain",
        storagePath: "/runtime/.maister/demo/runs/r1/uploads/m1/notes.txt",
      }),
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "review this" },
      {
        type: "resource_link",
        uri: "file:///runtime/.maister/demo/runs/r1/uploads/m1/notes.txt",
        name: "notes.txt",
        mimeType: "text/plain",
      },
    ]);
  });

  it("emits a resource_link for a confined file_path attachment (uri from its absolute path)", () => {
    const blocks = scratchPromptContentBlocks("look here", [
      stored({
        kind: "file_path",
        value: "/repos/demo-wt/src/app.ts",
        label: "entrypoint",
      }),
    ]);

    expect(blocks?.[1]).toEqual({
      type: "resource_link",
      uri: "file:///repos/demo-wt/src/app.ts",
      name: "entrypoint",
    });
  });

  it("falls back to the basename when a file_path attachment has no label", () => {
    const blocks = scratchPromptContentBlocks("x", [
      stored({ kind: "file_path", value: "/repos/demo-wt/src/app.ts" }),
    ]);

    expect(blocks?.[1]).toMatchObject({ name: "app.ts" });
  });

  it("skips issue_url / text_note (not file resources) but keeps file attachments", () => {
    const blocks = scratchPromptContentBlocks("mix", [
      stored({ kind: "text_note", value: "note" }),
      stored({
        kind: "uploaded_file",
        value: "ref",
        fileName: "a.txt",
        storagePath: "/runtime/a.txt",
      }),
      stored({ kind: "issue_url", value: "https://x/1" }),
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]).toEqual({ type: "text", text: "mix" });
    expect(blocks?.[1]).toMatchObject({ type: "resource_link", name: "a.txt" });
  });
});
