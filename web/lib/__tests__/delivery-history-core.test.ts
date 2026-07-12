import { describe, expect, it } from "vitest";

import {
  parseDeliveryHistory,
  parseTimestampedDeliveryHistory,
  summarizeDeliveryHistory,
} from "@/lib/delivery-history-core";

describe("delivery history core", () => {
  it("parses first-parent commit entries and retains per-commit numstat churn", () => {
    const history = parseDeliveryHistory(
      [
        "__MAISTER_COMMIT__a1\tbase",
        "4\t0\tsrc/widget.ts",
        "__MAISTER_COMMIT__b2\ta1",
        "0\t2\tsrc/widget.ts",
        "2\t0\tpnpm-lock.yaml",
      ].join("\n"),
    );

    expect(history).toEqual([
      {
        sha: "a1",
        parents: ["base"],
        files: [
          {
            path: "src/widget.ts",
            additions: 4,
            deletions: 0,
            binary: false,
          },
        ],
      },
      {
        sha: "b2",
        parents: ["a1"],
        files: [
          {
            path: "src/widget.ts",
            additions: 0,
            deletions: 2,
            binary: false,
          },
          {
            path: "pnpm-lock.yaml",
            additions: 2,
            deletions: 0,
            binary: false,
          },
        ],
      },
    ]);
    expect(summarizeDeliveryHistory(history)).toEqual({
      files: 2,
      additions: 4,
      deletions: 2,
    });
  });

  it("rejects malformed history before a cache writer can persist a partial scan", () => {
    expect(() => parseDeliveryHistory("4\t0\tsrc/widget.ts")).toThrow(
      "before a commit header",
    );
    expect(() =>
      parseDeliveryHistory("__MAISTER_COMMIT__a1\tbase\ninvalid"),
    ).toThrow("invalid row");
  });

  it("parses NUL-delimited timestamped commit messages and rename paths", () => {
    const history = parseTimestampedDeliveryHistory(
      [
        "a1b2c3d\0",
        "1783872000\0",
        "base\0",
        "feat: rename\n\nMaister-Run-Id: run-1\n\0",
        "4\t2\t\0",
        "generated/old.ts\0",
        "src/new.ts\0",
      ].join(""),
    );

    expect(history).toEqual([
      {
        sha: "a1b2c3d",
        parents: ["base"],
        committedAt: new Date("2026-07-12T16:00:00.000Z"),
        message: "feat: rename\n\nMaister-Run-Id: run-1\n",
        files: [
          {
            path: "src/new.ts",
            oldPath: "generated/old.ts",
            additions: 4,
            deletions: 2,
            binary: false,
          },
        ],
      },
    ]);
  });
});
