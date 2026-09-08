import { describe, expect, it } from "vitest";

import {
  safeDownloadFileName,
  safeDownloadHeaders,
} from "@/lib/http/safe-download";

// AB-12 (D5): pure header/filename invariants of the shared download policy.
// Route and browser suites prove the policy is APPLIED; this proves what it is.
describe("safeDownloadHeaders", () => {
  it("delivers opaque bytes as a sandboxed, non-sniffable, uncacheable attachment", () => {
    expect(
      safeDownloadHeaders({ fileName: "plan.log", mediaClass: "opaque" }),
    ).toEqual({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="plan.log"; filename*=UTF-8''plan.log`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    });
  });

  it("keeps server-derived text and JSON passive types under the same disposition", () => {
    expect(
      safeDownloadHeaders({ fileName: "diff-1.txt", mediaClass: "text" })[
        "content-type"
      ],
    ).toBe("text/plain; charset=utf-8");
    expect(
      safeDownloadHeaders({ fileName: "verdict.json", mediaClass: "json" }),
    ).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="verdict.json"; filename*=UTF-8''verdict.json`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    });
  });
});

describe("safeDownloadFileName", () => {
  it("passes a plain ASCII name through both parameters unchanged", () => {
    expect(safeDownloadFileName("scratch-upload-0123abcd-notes.txt")).toEqual({
      ascii: "scratch-upload-0123abcd-notes.txt",
      encoded: "scratch-upload-0123abcd-notes.txt",
    });
  });

  it("encodes non-ASCII per RFC 8187 and falls back to an ASCII-only filename", () => {
    expect(safeDownloadFileName("отчёт final.svg")).toEqual({
      ascii: "final.svg",
      encoded: "%D0%BE%D1%82%D1%87%D1%91%D1%82%20final.svg",
    });
    expect(safeDownloadFileName("отчёт")).toEqual({
      ascii: "download",
      encoded: "%D0%BE%D1%82%D1%87%D1%91%D1%82",
    });
  });

  it("drops header-unsafe bytes and path separators before either parameter is built", () => {
    expect(safeDownloadFileName('a"b\r\nc\\d/e.txt')).toEqual({
      ascii: "abcde.txt",
      encoded: "abcde.txt",
    });
    expect(safeDownloadFileName("../../etc/passwd")).toEqual({
      ascii: "etcpasswd",
      encoded: "....etcpasswd",
    });
  });

  it("never yields a dot-file, a bare dot sequence or an empty name", () => {
    expect(safeDownloadFileName(".env").ascii).toBe("env");
    expect(safeDownloadFileName("..").ascii).toBe("download");
    expect(safeDownloadFileName("   ")).toEqual({
      ascii: "download",
      encoded: "download",
    });
  });

  it("percent-encodes the characters encodeURIComponent leaves bare", () => {
    expect(safeDownloadFileName("a!'()*b.txt").encoded).toBe(
      "a%21%27%28%29%2Ab.txt",
    );
  });

  it("bounds both parameters", () => {
    const long = "x".repeat(400);
    const name = safeDownloadFileName(long);

    expect(name.ascii).toHaveLength(160);
    expect(name.encoded).toHaveLength(255);
  });
});
