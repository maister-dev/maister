import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import {
  packageFilesToSubmitValue,
  removePackageFile,
  renamePackageFilePath,
  replacePackageFileContent,
  upsertPackageFile,
} from "@/lib/flows/editor/package-files-draft";

function file(path: string, content = ""): AuthoredFlowPackageFile {
  return { kind: classifyPackageFilePath(path), path, content };
}

describe("package file draft helpers", () => {
  it("appends a schema file with inferred kind without mutating the input", () => {
    const files = [file("README.md", "hello")];
    const next = upsertPackageFile(files, "schemas/review.json", "{}");

    expect(next).toEqual([
      file("README.md", "hello"),
      { kind: "schema", path: "schemas/review.json", content: "{}" },
    ]);
    expect(files).toEqual([file("README.md", "hello")]);
  });

  it("replaces existing file content without duplicating the path", () => {
    const next = upsertPackageFile(
      [file("schemas/review.json", "{}")],
      "schemas/review.json",
      '{"fields":[]}',
    );

    expect(next).toEqual([file("schemas/review.json", '{"fields":[]}')]);
  });

  it("removes and renames files as new arrays with freshly inferred kinds", () => {
    const files = [file("notes.txt"), file("schemas/old.json")];
    const removed = removePackageFile(files, "notes.txt");
    const renamed = renamePackageFilePath(
      files,
      "notes.txt",
      "schemas/review.json",
    );

    expect(removed).toEqual([file("schemas/old.json")]);
    expect(removed).not.toBe(files);
    expect(renamed).toEqual([
      file("schemas/review.json"),
      file("schemas/old.json"),
    ]);
    expect(renamed[0].kind).toBe("schema");
    expect(renamed).not.toBe(files);
  });

  it("replaces content for only the targeted file", () => {
    const files = [file("README.md", "old"), file("notes.txt", "keep")];
    const next = replacePackageFileContent(files, "README.md", "new");

    expect(next).toEqual([file("README.md", "new"), file("notes.txt", "keep")]);
  });

  it("serializes the exact file array submitted through packageFilesJson", () => {
    const files = [file("README.md", "hello")];

    expect(packageFilesToSubmitValue(files)).toBe(JSON.stringify(files));
  });
});
