import { describe, expect, it } from "vitest";

import {
  composeCommitMessage,
  MaisterProvenanceError,
  parseMaisterTrailers,
} from "@/lib/worktree-provenance-core";
import {
  cleanDeliveryStats,
  isExcludedDeliveryPath,
} from "@/lib/delivery-pathspec";

describe("worktree provenance core", () => {
  it("appends only missing truthful trailers and keeps the subject clean", () => {
    const message = composeCommitMessage("feat: add telemetry", {
      runId: "run-123",
      task: "MAI-42",
      flow: "acme/flow@abcdef1",
      node: "implement",
    });

    expect(message).toBe(
      "feat: add telemetry\n\nMaister-Run-Id: run-123\nMaister-Task: MAI-42\nMaister-Flow: acme/flow@abcdef1\nMaister-Node: implement\n",
    );
  });

  it("preserves a matching Run ID, fills a missing trailer once, and omits taskless fields", () => {
    const message = composeCommitMessage(
      "fix: persist state\n\nMaister-Run-Id: run-123\n",
      { runId: "run-123" },
    );

    expect(message).toBe("fix: persist state\n\nMaister-Run-Id: run-123\n");
    expect(parseMaisterTrailers(message)).toEqual({ runId: "run-123" });
  });

  it("rejects a conflicting Run ID and unsafe metadata", () => {
    expect(() =>
      composeCommitMessage("chore: update", { runId: "run-123" }, [
        "Maister-Run-Id: another-run",
      ]),
    ).toThrow(MaisterProvenanceError);
    expect(() =>
      composeCommitMessage("chore: update", { runId: "run\n123" }),
    ).toThrow(MaisterProvenanceError);
    expect(() =>
      composeCommitMessage("chore: update\0", { runId: "run-123" }),
    ).toThrow(MaisterProvenanceError);
    expect(() =>
      parseMaisterTrailers(
        "chore: update\n\nMaister-Run-Id: run-123\nMaister-Run-Id: run-123\n",
      ),
    ).toThrow("duplicate Maister-Run-Id trailers");
  });

  it("rejects fabricated task or flow identity for a taskless worktree", () => {
    expect(() =>
      composeCommitMessage("chore: update", { runId: "run-123" }, [
        "Maister-Task: MAI-99",
      ]),
    ).toThrow("unexpected Maister-Task trailer");
    expect(() =>
      composeCommitMessage("chore: update", { runId: "run-123" }, [
        "Maister-Flow: acme/flow@abcdef1",
      ]),
    ).toThrow("unexpected Maister-Flow trailer");
    expect(() =>
      composeCommitMessage("chore: update", { runId: "run-123" }, [
        "Maister-Node: implement",
      ]),
    ).toThrow("unexpected Maister-Node trailer");
  });
});

describe("delivery path cleaning", () => {
  it("excludes frozen dependency/generated paths, including rename sources", () => {
    expect(isExcludedDeliveryPath("pnpm-lock.yaml")).toBe(true);
    expect(isExcludedDeliveryPath("vendor/sdk/index.ts")).toBe(true);
    expect(isExcludedDeliveryPath("src/generated/client.ts")).toBe(true);
    expect(isExcludedDeliveryPath("src/product.ts")).toBe(false);

    expect(
      cleanDeliveryStats([
        {
          path: "src/product.ts",
          additions: 4,
          deletions: 1,
          binary: false,
        },
        {
          path: "src/product.ts",
          oldPath: "vendor/sdk/index.ts",
          additions: 5,
          deletions: 3,
          binary: false,
        },
        {
          path: "assets/logo.png",
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ]),
    ).toEqual({ files: 2, additions: 4, deletions: 1 });
  });
});
