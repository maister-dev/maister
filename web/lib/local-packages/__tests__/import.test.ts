import { describe, expect, it } from "vitest";

import { cleanArchiveMemberPath, detectArchiveKind } from "../import";

// Pure planner helpers — no fs, no PG. The confine+cap+write path is covered by
// import.integration.test.ts; these pin the path-cleaning + magic-detection edge
// cases that are the security crux.
describe("cleanArchiveMemberPath", () => {
  it("strips a leading ./ and keeps nested segments", () => {
    expect(cleanArchiveMemberPath("./sub/x.txt")).toBe("sub/x.txt");
    expect(cleanArchiveMemberPath("flows/a/flow.yaml")).toBe(
      "flows/a/flow.yaml",
    );
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(cleanArchiveMemberPath("flows\\a\\flow.yaml")).toBe(
      "flows/a/flow.yaml",
    );
  });

  it("rejects POSIX parent traversal on the ORIGINAL segments", () => {
    expect(() => cleanArchiveMemberPath("../escape")).toThrow();
    expect(() => cleanArchiveMemberPath("schemas/../setup.sh")).toThrow();
  });

  it("rejects Windows parent traversal on the ORIGINAL segments", () => {
    expect(() => cleanArchiveMemberPath("..\\escape")).toThrow();
    expect(() => cleanArchiveMemberPath("a\\..\\..\\escape")).toThrow();
  });

  it("rejects absolute paths (posix + backslash + drive-letter)", () => {
    expect(() => cleanArchiveMemberPath("/etc/passwd")).toThrow();
    expect(() => cleanArchiveMemberPath("\\windows\\system32")).toThrow();
    expect(() => cleanArchiveMemberPath("C:\\evil")).toThrow();
  });

  it("rejects a NUL byte", () => {
    expect(() => cleanArchiveMemberPath("a\0b")).toThrow();
  });

  it("rejects an all-empty / dot-only path", () => {
    expect(() => cleanArchiveMemberPath("./")).toThrow();
    expect(() => cleanArchiveMemberPath("")).toThrow();
  });
});

describe("detectArchiveKind", () => {
  it("detects zip by magic (PK)", () => {
    expect(detectArchiveKind("x.bin", new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(
      "zip",
    );
  });

  it("detects gzip by magic", () => {
    expect(detectArchiveKind("x.bin", new Uint8Array([0x1f, 0x8b, 8]))).toBe(
      "tar.gz",
    );
  });

  it("falls back to file name when magic is absent", () => {
    const plain = new Uint8Array([1, 2, 3]);

    expect(detectArchiveKind("a.zip", plain)).toBe("zip");
    expect(detectArchiveKind("a.tar.gz", plain)).toBe("tar.gz");
    expect(detectArchiveKind("a.tgz", plain)).toBe("tar.gz");
    expect(detectArchiveKind("a.txt", plain)).toBeNull();
  });
});
